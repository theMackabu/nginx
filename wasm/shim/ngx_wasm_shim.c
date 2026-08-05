#include <ngx_config.h>
#include <ngx_core.h>
#include <ngx_event.h>
#include <ngx_http.h>

#include <emscripten.h>
#include <wasi/api.h>

#include <sys/socket.h>
#include <sys/ioctl.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>
#include <errno.h>
#include <netdb.h>
#include <arpa/inet.h>

#define NGXW_FD_BASE   700
#define NGXW_FD_MAX    1000
#define NGXW_NSLOTS    (NGXW_FD_MAX - NGXW_FD_BASE)

#define NGXW_OUT_HIWATER  (256 * 1024)

EM_JS(void, ngxw_js_conn_data, (int fd), {
    Module['onConnData'] && Module['onConnData'](fd);
});

EM_JS(void, ngxw_js_conn_close, (int fd), {
    Module['onConnClose'] && Module['onConnClose'](fd);
});

EM_JS(void, ngxw_js_upstream_connect, (int fd, const char *ip, int port), {
    Module['onUpstreamConnect']
        && Module['onUpstreamConnect'](fd, UTF8ToString(ip), port);
});

EM_JS(void, ngxw_js_udp_connect, (int fd, const char *ip, int port), {
    Module['onUdpConnect']
        && Module['onUdpConnect'](fd, UTF8ToString(ip), port);
});

EM_JS(void, ngxw_js_invoke_handler, (const char *id, int token), {
    Module['onJsHandler'] && Module['onJsHandler'](UTF8ToString(id), token);
});

EM_JS(void, ngxw_js_invoke_access, (const char *id, int token), {
    Module['onJsAccess'] && Module['onJsAccess'](UTF8ToString(id), token);
});

EM_JS(unsigned, ngxw_js_resolve, (const char *name), {
    var m = Module['hostsMap'];
    if (!m) return 0;
    var ip = m[UTF8ToString(name)];
    if (!ip) return 0;
    var p = ip.split('.');
    if (p.length !== 4) return 0;
    return (((+p[0] & 255)) | ((+p[1] & 255) << 8)
          | ((+p[2] & 255) << 16) | ((+p[3] & 255) << 24)) >>> 0;
});

typedef struct {
    u_char  *data;
    size_t   len;
    size_t   off;
    size_t   cap;
} ngxw_buf_t;

static int
ngxw_buf_append(ngxw_buf_t *b, const u_char *data, size_t n)
{
    size_t   cap;
    u_char  *p;

    if (b->off == b->len) {
        b->off = 0;
        b->len = 0;
    }

    if (b->len + n > b->cap) {
        cap = b->cap ? b->cap : 4096;
        while (cap < b->len + n) {
            cap *= 2;
        }
        p = realloc(b->data, cap);
        if (p == NULL) {
            return -1;
        }
        b->data = p;
        b->cap = cap;
    }

    memcpy(b->data + b->len, data, n);
    b->len += n;

    return 0;
}

static void
ngxw_buf_free(ngxw_buf_t *b)
{
    free(b->data);
    b->data = NULL;
    b->len = b->off = b->cap = 0;
}

#define NGXW_DGRAM_Q  64

typedef struct {
    unsigned    used:1;
    unsigned    upstream:1;
    unsigned    eof:1;
    unsigned    dgram:1;
    int         err;
    ngxw_buf_t  in;
    ngxw_buf_t  out;

    size_t      dq_len[NGXW_DGRAM_Q];
    int         dq_head;
    int         dq_tail;
    ngx_connection_t  *c;
} ngxw_slot_t;

static ngxw_slot_t   ngxw_slots[NGXW_NSLOTS];
static int           ngxw_next = 0;

static ngx_cycle_t  *ngxw_cycle;
static ngx_uint_t    ngxw_conn_number;

static struct sockaddr_storage  ngxw_bound[NGXW_NSLOTS];
static socklen_t                ngxw_bound_len[NGXW_NSLOTS];

static int
ngxw_is_fake(int fd)
{
    return fd >= NGXW_FD_BASE && fd < NGXW_FD_MAX;
}

static ngxw_slot_t *
ngxw_slot(int fd)
{
    if (!ngxw_is_fake(fd) || !ngxw_slots[fd - NGXW_FD_BASE].used) {
        return NULL;
    }

    return &ngxw_slots[fd - NGXW_FD_BASE];
}

static int
ngxw_alloc_fd(void)
{
    int  i, idx;

    for (i = 0; i < NGXW_NSLOTS; i++) {
        idx = (ngxw_next + i) % NGXW_NSLOTS;
        if (!ngxw_slots[idx].used) {
            ngxw_next = idx + 1;
            memset(&ngxw_slots[idx], 0, sizeof(ngxw_slot_t));
            ngxw_slots[idx].used = 1;
            return NGXW_FD_BASE + idx;
        }
    }

    errno = EMFILE;
    return -1;
}

static ngx_connection_t *
ngxw_find_conn(int fd)
{
    ngx_uint_t         i;
    ngx_connection_t  *c;
    ngxw_slot_t       *sl;

    sl = ngxw_slot(fd);

    if (sl && sl->c && sl->c->fd == fd) {
        return sl->c;
    }

    if (ngxw_cycle == NULL) {
        return NULL;
    }

    c = ngxw_cycle->connections;
    for (i = 0; i < ngxw_cycle->connection_n; i++) {
        if (c[i].fd == (ngx_socket_t) fd) {
            if (sl) {
                sl->c = &c[i];
            }
            return &c[i];
        }
    }

    return NULL;
}

int
gettimeofday(struct timeval *restrict tv, void *restrict tz)
{
    struct timespec  ts;

    (void) tz;

    if (clock_gettime(CLOCK_REALTIME, &ts) != 0) {
        return -1;
    }

    tv->tv_sec = ts.tv_sec;
    tv->tv_usec = (suseconds_t) (ts.tv_nsec / 1000);

    return 0;
}

time_t
time(time_t *t)
{
    struct timespec  ts;

    if (clock_gettime(CLOCK_REALTIME, &ts) != 0) {
        return (time_t) -1;
    }

    if (t) {
        *t = ts.tv_sec;
    }

    return ts.tv_sec;
}

uid_t
geteuid(void)
{

    return 1000;
}

int
getaddrinfo(const char *node, const char *service,
    const struct addrinfo *hints, struct addrinfo **res)
{
    in_addr_t            addr;
    struct addrinfo     *ai;
    struct sockaddr_in  *sin;

    (void) service;
    (void) hints;

    if (node == NULL) {
        return EAI_NONAME;
    }

    addr = inet_addr(node);

    if (addr == INADDR_NONE) {
        addr = (in_addr_t) ngxw_js_resolve(node);
        if (addr == 0) {
            return EAI_NONAME;
        }
    }

    ai = calloc(1, sizeof(struct addrinfo));
    sin = calloc(1, sizeof(struct sockaddr_in));

    if (ai == NULL || sin == NULL) {
        free(ai);
        free(sin);
        return EAI_MEMORY;
    }

    sin->sin_family = AF_INET;
    sin->sin_addr.s_addr = addr;

    ai->ai_family = AF_INET;
    ai->ai_socktype = SOCK_STREAM;
    ai->ai_addr = (struct sockaddr *) sin;
    ai->ai_addrlen = sizeof(struct sockaddr_in);
    ai->ai_next = NULL;

    *res = ai;

    return 0;
}

void
freeaddrinfo(struct addrinfo *res)
{
    struct addrinfo  *next;

    while (res) {
        next = res->ai_next;
        free(res->ai_addr);
        free(res);
        res = next;
    }
}

int
socket(int domain, int type, int protocol)
{
    int           fd;
    ngxw_slot_t  *sl;

    fd = ngxw_alloc_fd();

    sl = ngxw_slot(fd);
    if (sl && (type & 0xff) == SOCK_DGRAM) {
        sl->dgram = 1;
    }

    return fd;
}

int
bind(int fd, const struct sockaddr *addr, socklen_t len)
{
    if (ngxw_is_fake(fd) && len <= sizeof(struct sockaddr_storage)) {
        memcpy(&ngxw_bound[fd - NGXW_FD_BASE], addr, len);
        ngxw_bound_len[fd - NGXW_FD_BASE] = len;
    }

    return 0;
}

int
listen(int fd, int backlog)
{
    return 0;
}

int
setsockopt(int fd, int level, int optname, const void *optval, socklen_t len)
{
    return 0;
}

int
getsockopt(int fd, int level, int optname, void *optval, socklen_t *len)
{
    ngxw_slot_t  *sl;

    if (optval && len && *len) {
        memset(optval, 0, *len);

        if (level == SOL_SOCKET && optname == SO_ERROR
            && *len >= sizeof(int))
        {
            sl = ngxw_slot(fd);
            if (sl) {
                *(int *) optval = sl->err;
            }
        }
    }

    return 0;
}

int
getsockname(int fd, struct sockaddr *addr, socklen_t *len)
{
    socklen_t  n;

    if (ngxw_is_fake(fd) && ngxw_bound_len[fd - NGXW_FD_BASE]) {
        n = ngxw_bound_len[fd - NGXW_FD_BASE];
        if (*len < n) {
            n = *len;
        }
        memcpy(addr, &ngxw_bound[fd - NGXW_FD_BASE], n);
        *len = n;
        return 0;
    }

    errno = EBADF;
    return -1;
}

int
accept(int fd, struct sockaddr *addr, socklen_t *len)
{
    errno = EAGAIN;
    return -1;
}

int
connect(int fd, const struct sockaddr *addr, socklen_t len)
{
    u_char                     text[NGX_SOCKADDR_STRLEN + 1];
    size_t                     n;
    ngxw_slot_t               *sl;
    const struct sockaddr_in  *sin;

    sl = ngxw_slot(fd);

    if (sl == NULL) {
        errno = EBADF;
        return -1;
    }

    sl->upstream = 1;

    if (addr->sa_family == AF_INET) {
        sin = (const struct sockaddr_in *) addr;

        n = ngx_inet_ntop(AF_INET, (void *) &sin->sin_addr, text,
                          NGX_SOCKADDR_STRLEN);
        text[n] = '\0';

        if (sl->dgram) {

            ngxw_js_udp_connect(fd, (const char *) text,
                                (int) ntohs(sin->sin_port));
            return 0;
        }

        ngxw_js_upstream_connect(fd, (const char *) text,
                                 (int) ntohs(sin->sin_port));

        errno = EINPROGRESS;
        return -1;
    }

    errno = EAFNOSUPPORT;
    return -1;
}

int
shutdown(int fd, int how)
{
    return 0;
}

int
ioctl(int fd, int req, ...)
{
    return 0;
}

ssize_t
recv(int fd, void *buf, size_t n, int flags)
{
    size_t        left, take;
    ngxw_slot_t  *sl;

    sl = ngxw_slot(fd);

    if (sl == NULL) {
        errno = EBADF;
        return -1;
    }

    if (sl->dgram) {

        size_t  dlen;

        if (sl->dq_head == sl->dq_tail) {
            errno = EAGAIN;
            return -1;
        }

        dlen = sl->dq_len[sl->dq_head];
        sl->dq_head = (sl->dq_head + 1) % NGXW_DGRAM_Q;

        take = dlen < n ? dlen : n;
        memcpy(buf, sl->in.data + sl->in.off, take);
        sl->in.off += dlen;

        return (ssize_t) take;
    }

    left = sl->in.len - sl->in.off;

    if (left == 0) {
        if (sl->eof) {
            return 0;
        }
        errno = EAGAIN;
        return -1;
    }

    take = left < n ? left : n;
    memcpy(buf, sl->in.data + sl->in.off, take);

    if (!(flags & MSG_PEEK)) {
        sl->in.off += take;
    }

    return (ssize_t) take;
}

ssize_t
readv(int fd, const struct iovec *iov, int iovcnt)
{
    int          i;
    ssize_t      n, total;

    if (!ngxw_is_fake(fd)) {
        errno = EBADF;
        return -1;
    }

    total = 0;

    for (i = 0; i < iovcnt; i++) {
        n = recv(fd, iov[i].iov_base, iov[i].iov_len, 0);

        if (n < 0) {
            return total ? total : n;
        }
        total += n;
        if ((size_t) n < iov[i].iov_len) {
            break;
        }
    }

    return total;
}

static size_t
ngxw_out_budget(ngxw_slot_t *sl)
{
    size_t  pending = sl->out.len - sl->out.off;

    return pending >= NGXW_OUT_HIWATER ? 0 : NGXW_OUT_HIWATER - pending;
}

ssize_t
send(int fd, const void *buf, size_t n, int flags)
{
    size_t        budget;
    ngxw_slot_t  *sl;

    sl = ngxw_slot(fd);

    if (sl == NULL) {
        errno = EBADF;
        return -1;
    }

    budget = ngxw_out_budget(sl);

    if (budget == 0) {
        errno = EAGAIN;
        return -1;
    }

    if (n > budget) {
        n = budget;
    }

    if (ngxw_buf_append(&sl->out, buf, n) != 0) {
        errno = ENOMEM;
        return -1;
    }

    ngxw_js_conn_data(fd);

    return (ssize_t) n;
}

ssize_t
writev(int fd, const struct iovec *iov, int iovcnt)
{
    int           i;
    size_t        take, budget;
    ssize_t       total;
    ngxw_slot_t  *sl;

    sl = ngxw_slot(fd);

    if (sl == NULL) {
        errno = EBADF;
        return -1;
    }

    budget = ngxw_out_budget(sl);

    if (budget == 0) {
        errno = EAGAIN;
        return -1;
    }

    total = 0;

    for (i = 0; i < iovcnt && budget; i++) {
        take = iov[i].iov_len < budget ? iov[i].iov_len : budget;

        if (ngxw_buf_append(&sl->out, iov[i].iov_base, take) != 0) {
            errno = ENOMEM;
            return -1;
        }
        total += take;
        budget -= take;
    }

    ngxw_js_conn_data(fd);

    return total;
}

ssize_t
read(int fd, void *buf, size_t n)
{
    size_t          nread;
    __wasi_errno_t  err;
    __wasi_iovec_t  iov;

    if (ngxw_is_fake(fd)) {
        return recv(fd, buf, n, 0);
    }

    iov.buf = buf;
    iov.buf_len = n;

    err = __wasi_fd_read(fd, &iov, 1, &nread);
    if (err) {
        errno = err;
        return -1;
    }

    return (ssize_t) nread;
}

ssize_t
write(int fd, const void *buf, size_t n)
{
    size_t           nwritten;
    __wasi_errno_t   err;
    __wasi_ciovec_t  iov;

    if (ngxw_is_fake(fd)) {
        return send(fd, buf, n, 0);
    }

    iov.buf = buf;
    iov.buf_len = n;

    err = __wasi_fd_write(fd, &iov, 1, &nwritten);
    if (err) {
        errno = err;
        return -1;
    }

    return (ssize_t) nwritten;
}

int
close(int fd)
{
    __wasi_errno_t  err;
    ngxw_slot_t    *sl;

    if (ngxw_is_fake(fd)) {
        sl = ngxw_slot(fd);

        if (sl) {

            if (sl->out.len > sl->out.off) {
                ngxw_js_conn_data(fd);
            }
            ngxw_js_conn_close(fd);
            ngxw_buf_free(&sl->in);
            ngxw_buf_free(&sl->out);
            sl->used = 0;
            sl->c = NULL;
        }

        ngxw_bound_len[fd - NGXW_FD_BASE] = 0;
        return 0;
    }

    err = __wasi_fd_close(fd);
    if (err) {
        errno = err;
        return -1;
    }

    return 0;
}

static void
ngxw_set_str(ngx_pool_t *pool, ngx_str_t *s, const char *v)
{
    s->len = ngx_strlen(v);
    s->data = ngx_pnalloc(pool, s->len + 1);
    ngx_memcpy(s->data, v, s->len + 1);
}

EMSCRIPTEN_KEEPALIVE
int
nginxw_init(const char *prefix, const char *conf_file, const char *conf_param)
{
    ngx_uint_t    i;
    ngx_log_t    *log;
    ngx_cycle_t   init_cycle, *cycle;
    const char   *p;

    if (ngx_strerror_init() != NGX_OK) {
        return 1;
    }

    ngx_max_sockets = -1;

    ngx_time_init();

#if (NGX_PCRE)
    ngx_regex_init();
#endif

    ngx_pid = ngx_getpid();
    ngx_parent = ngx_getppid();

    log = ngx_log_init((u_char *) prefix, (u_char *) "");
    if (log == NULL) {
        return 2;
    }

#if (NGX_OPENSSL)
    ngx_ssl_init(log);
#endif

    ngx_memzero(&init_cycle, sizeof(ngx_cycle_t));
    init_cycle.log = log;
    ngx_cycle = &init_cycle;

    init_cycle.pool = ngx_create_pool(1024, log);
    if (init_cycle.pool == NULL) {
        return 3;
    }

    ngxw_set_str(init_cycle.pool, &init_cycle.prefix, prefix);
    ngxw_set_str(init_cycle.pool, &init_cycle.conf_file, conf_file);

    p = strrchr(conf_file, '/');
    if (p) {
        init_cycle.conf_prefix.len = p - conf_file + 1;
        init_cycle.conf_prefix.data = ngx_pnalloc(init_cycle.pool,
                                                  init_cycle.conf_prefix.len);
        ngx_memcpy(init_cycle.conf_prefix.data, conf_file,
                   init_cycle.conf_prefix.len);
    } else {
        init_cycle.conf_prefix = init_cycle.prefix;
    }

    ngxw_set_str(init_cycle.pool, &init_cycle.conf_param,
                 conf_param ? conf_param : "");

    if (ngx_os_init(log) != NGX_OK) {
        return 4;
    }

    if (ngx_crc32_table_init() != NGX_OK) {
        return 5;
    }

    ngx_slab_sizes_init();

    if (ngx_preinit_modules() != NGX_OK) {
        return 6;
    }

    cycle = ngx_init_cycle(&init_cycle);
    if (cycle == NULL) {
        return 7;
    }

    ngx_cycle = cycle;
    ngxw_cycle = cycle;
    ngx_process = NGX_PROCESS_SINGLE;

    for (i = 0; cycle->modules[i]; i++) {
        if (cycle->modules[i]->init_process) {
            if (cycle->modules[i]->init_process(cycle) == NGX_ERROR) {
                return 8;
            }
        }
    }

    return 0;
}

static void
ngxw_drain(void)
{
    ngx_uint_t  n;

    for (n = 0; n < 64; n++) {
        ngx_event_move_posted_next((ngx_cycle_t *) ngx_cycle);

        if (ngx_queue_empty(&ngx_posted_events)) {
            break;
        }

        ngx_event_process_posted((ngx_cycle_t *) ngx_cycle,
                                 &ngx_posted_events);
    }
}

EMSCRIPTEN_KEEPALIVE
int
nginxw_tick(void)
{
    ngx_msec_t  t;

    if (ngxw_cycle == NULL) {
        return -1;
    }

    ngx_time_update();
    ngx_event_expire_timers();
    ngxw_drain();

    t = ngx_event_find_timer();

    if (t == NGX_TIMER_INFINITE) {
        return -1;
    }

    return t > 0x7fffffff ? 0x7fffffff : (int) t;
}

EMSCRIPTEN_KEEPALIVE
int
nginxw_listen_count(void)
{
    return ngxw_cycle ? (int) ngxw_cycle->listening.nelts : 0;
}

EMSCRIPTEN_KEEPALIVE
int
nginxw_listen_port(int i)
{
    ngx_listening_t  *ls;

    if (ngxw_cycle == NULL
        || (ngx_uint_t) i >= ngxw_cycle->listening.nelts)
    {
        return -1;
    }

    ls = ngxw_cycle->listening.elts;

    return (int) ngx_inet_get_port(ls[i].sockaddr);
}

EMSCRIPTEN_KEEPALIVE
int
nginxw_accept(int port, const char *client_ip, int client_port)
{
    int                  fd;
    in_addr_t            inaddr;
    ngx_uint_t           i;
    ngx_log_t           *log;
    ngx_event_t         *rev, *wev;
    ngxw_slot_t         *sl;
    ngx_listening_t     *ls, *found;
    ngx_connection_t    *c;
    struct sockaddr_in  *sin;

    if (ngxw_cycle == NULL) {
        return -1;
    }

    ngx_time_update();

    found = NULL;
    ls = ngxw_cycle->listening.elts;

    for (i = 0; i < ngxw_cycle->listening.nelts; i++) {
        if (ngx_inet_get_port(ls[i].sockaddr) == (in_port_t) port) {
            found = &ls[i];
            break;
        }
    }

    if (found == NULL && ngxw_cycle->listening.nelts > 0) {
        found = &ls[0];
    }

    if (found == NULL) {
        return -2;
    }

    fd = ngxw_alloc_fd();
    if (fd < 0) {
        return -3;
    }

    c = ngx_get_connection(fd, ngxw_cycle->log);
    if (c == NULL) {
        ngxw_slots[fd - NGXW_FD_BASE].used = 0;
        return -4;
    }

    c->type = SOCK_STREAM;

    c->pool = ngx_create_pool(found->pool_size, ngxw_cycle->log);
    if (c->pool == NULL) {
        goto failed;
    }

    sin = ngx_pcalloc(c->pool, sizeof(struct sockaddr_in));
    if (sin == NULL) {
        goto failed;
    }

    inaddr = ngx_inet_addr((u_char *) client_ip, ngx_strlen(client_ip));
    if (inaddr == INADDR_NONE) {
        inaddr = htonl(INADDR_LOOPBACK);
    }

    sin->sin_family = AF_INET;
    sin->sin_port = htons((in_port_t) client_port);
    sin->sin_addr.s_addr = inaddr;

    c->sockaddr = (struct sockaddr *) sin;
    c->socklen = sizeof(struct sockaddr_in);

    log = ngx_palloc(c->pool, sizeof(ngx_log_t));
    if (log == NULL) {
        goto failed;
    }

    *log = found->log;
    c->log = log;
    c->pool->log = log;

    c->addr_text.len = ngx_strlen(client_ip);
    c->addr_text.data = ngx_pnalloc(c->pool, c->addr_text.len);
    if (c->addr_text.data == NULL) {
        goto failed;
    }
    ngx_memcpy(c->addr_text.data, client_ip, c->addr_text.len);

    c->recv = ngx_io.recv;
    c->send = ngx_io.send;
    c->recv_chain = ngx_io.recv_chain;
    c->send_chain = ngx_io.send_chain;

    c->listening = found;
    c->local_sockaddr = found->sockaddr;
    c->local_socklen = found->socklen;

    c->start_time = ngx_current_msec;
    c->number = ++ngxw_conn_number;

    rev = c->read;
    wev = c->write;

    rev->log = log;
    wev->log = log;

    rev->ready = 0;
    wev->ready = 1;

    sl = ngxw_slot(fd);
    sl->c = c;

    ngx_http_init_connection(c);
    ngxw_drain();

    return fd;

failed:

    if (c->pool) {
        ngx_destroy_pool(c->pool);
        c->pool = NULL;
    }
    ngx_close_connection(c);
    return -4;
}

EMSCRIPTEN_KEEPALIVE
int
nginxw_push(int fd, const u_char *data, int len)
{
    ngxw_slot_t       *sl;
    ngx_connection_t  *c;

    sl = ngxw_slot(fd);

    if (sl == NULL) {
        return -1;
    }

    if (len > 0 && ngxw_buf_append(&sl->in, data, (size_t) len) != 0) {
        return -2;
    }

    ngx_time_update();

    c = ngxw_find_conn(fd);

    if (c && c->read->handler) {
        c->read->ready = 1;
        c->read->handler(c->read);
        ngxw_drain();
    }

    return 0;
}

EMSCRIPTEN_KEEPALIVE
int
nginxw_push_dgram(int fd, const u_char *data, int len)
{
    ngxw_slot_t       *sl;
    ngx_connection_t  *c;

    sl = ngxw_slot(fd);

    if (sl == NULL) {
        return -1;
    }

    if ((sl->dq_tail + 1) % NGXW_DGRAM_Q == sl->dq_head) {
        return -3;
    }

    if (len > 0 && ngxw_buf_append(&sl->in, data, (size_t) len) != 0) {
        return -2;
    }

    sl->dq_len[sl->dq_tail] = (size_t) len;
    sl->dq_tail = (sl->dq_tail + 1) % NGXW_DGRAM_Q;

    ngx_time_update();

    c = ngxw_find_conn(fd);

    if (c && c->read->handler) {
        c->read->ready = 1;
        c->read->handler(c->read);
        ngxw_drain();
    }

    return 0;
}

EMSCRIPTEN_KEEPALIVE
int
nginxw_eof(int fd)
{
    ngxw_slot_t       *sl;
    ngx_connection_t  *c;

    sl = ngxw_slot(fd);

    if (sl == NULL) {
        return -1;
    }

    sl->eof = 1;

    ngx_time_update();

    c = ngxw_find_conn(fd);

    if (c && c->read->handler) {
        c->read->ready = 1;
        c->read->pending_eof = 1;
        c->read->handler(c->read);
        ngxw_drain();
    }

    return 0;
}

EMSCRIPTEN_KEEPALIVE
int
nginxw_conn_ready(int fd)
{
    ngx_connection_t  *c;

    ngx_time_update();

    c = ngxw_find_conn(fd);

    if (c == NULL || c->write->handler == NULL) {
        return -1;
    }

    c->write->ready = 1;
    c->write->handler(c->write);
    ngxw_drain();

    return 0;
}

EMSCRIPTEN_KEEPALIVE
int
nginxw_conn_error(int fd, int err)
{
    ngxw_slot_t       *sl;
    ngx_connection_t  *c;

    sl = ngxw_slot(fd);

    if (sl == NULL) {
        return -1;
    }

    sl->err = err ? err : ECONNREFUSED;
    sl->eof = 1;

    ngx_time_update();

    c = ngxw_find_conn(fd);

    if (c && c->write->handler) {
        c->write->ready = 1;
        c->write->handler(c->write);
        ngxw_drain();
    }

    c = ngxw_find_conn(fd);

    if (c && c->read->handler) {
        c->read->ready = 1;
        c->read->pending_eof = 1;
        c->read->handler(c->read);
        ngxw_drain();
    }

    return 0;
}

EMSCRIPTEN_KEEPALIVE
int
nginxw_writable(int fd)
{
    ngx_connection_t  *c;

    ngx_time_update();

    c = ngxw_find_conn(fd);

    if (c == NULL || c->write->handler == NULL) {
        return -1;
    }

    c->write->ready = 1;
    c->write->handler(c->write);
    ngxw_drain();

    return 0;
}

EMSCRIPTEN_KEEPALIVE
int
nginxw_in_size(int fd)
{
    ngxw_slot_t  *sl = ngxw_slot(fd);

    return sl ? (int) (sl->in.len - sl->in.off) : 0;
}

EMSCRIPTEN_KEEPALIVE
int
nginxw_out_size(int fd)
{
    ngxw_slot_t  *sl = ngxw_slot(fd);

    return sl ? (int) (sl->out.len - sl->out.off) : 0;
}

EMSCRIPTEN_KEEPALIVE
int
nginxw_reload(void)
{
    ngx_uint_t         i;
    ngx_cycle_t       *cycle;
    ngx_connection_t  *c;

    if (ngxw_cycle == NULL) {
        return -1;
    }

    ngx_time_update();

    c = ngxw_cycle->connections;

    for (i = 0; i < ngxw_cycle->connection_n; i++) {
        if (c[i].fd != (ngx_socket_t) -1 && !c[i].read->accept) {
            ngx_close_connection(&c[i]);
        }
    }

    cycle = ngx_init_cycle(ngxw_cycle);
    if (cycle == NULL) {
        return 7;
    }

    ngx_cycle = cycle;
    ngxw_cycle = cycle;
    ngx_process = NGX_PROCESS_SINGLE;

    for (i = 0; cycle->modules[i]; i++) {
        if (cycle->modules[i]->init_process) {
            if (cycle->modules[i]->init_process(cycle) == NGX_ERROR) {
                return 8;
            }
        }
    }

    return 0;
}

static void
ngxw_json_str(ngxw_buf_t *b, ngx_str_t *s)
{
    size_t   i;
    u_char   ch;

    ngxw_buf_append(b, (u_char *) "\"", 1);

    for (i = 0; i < s->len; i++) {
        ch = s->data[i];
        if (ch == '"' || ch == '\\') {
            ngxw_buf_append(b, (u_char *) "\\", 1);
        }
        if (ch >= 0x20) {
            ngxw_buf_append(b, &ch, 1);
        }
    }

    ngxw_buf_append(b, (u_char *) "\"", 1);
}

static void
ngxw_json_lit(ngxw_buf_t *b, const char *s)
{
    ngxw_buf_append(b, (const u_char *) s, strlen(s));
}

EMSCRIPTEN_KEEPALIVE
char *
nginxw_describe(void)
{
    char                            *out;
    ngxw_buf_t                       b;
    ngx_uint_t                       i, j, k;
    ngx_http_conf_ctx_t             *ctx;
    ngx_http_core_srv_conf_t       **cscfp;
    ngx_http_core_main_conf_t       *cmcf;
    ngx_http_upstream_server_t      *us;
    ngx_http_upstream_srv_conf_t   **uscfp;
    ngx_http_upstream_main_conf_t   *umcf;

    if (ngxw_cycle == NULL) {
        return NULL;
    }

    ngx_memzero(&b, sizeof(b));

    ctx = (ngx_http_conf_ctx_t *) ngx_get_conf(ngxw_cycle->conf_ctx,
                                               ngx_http_module);
    if (ctx == NULL) {
        ngxw_json_lit(&b, "{\"servers\":[],\"upstreams\":{}}");
        goto done;
    }

    cmcf = ctx->main_conf[ngx_http_core_module.ctx_index];
    umcf = ctx->main_conf[ngx_http_upstream_module.ctx_index];

    ngxw_json_lit(&b, "{\"servers\":[");

    cscfp = cmcf->servers.elts;
    for (i = 0; i < cmcf->servers.nelts; i++) {
        if (i) {
            ngxw_json_lit(&b, ",");
        }
        ngxw_json_lit(&b, "{\"name\":");
        ngxw_json_str(&b, &cscfp[i]->server_name);
        ngxw_json_lit(&b, "}");
    }

    ngxw_json_lit(&b, "],\"upstreams\":{");

    if (umcf) {
        uscfp = umcf->upstreams.elts;
        k = 0;
        for (i = 0; i < umcf->upstreams.nelts; i++) {
            if (k++) {
                ngxw_json_lit(&b, ",");
            }
            ngxw_json_str(&b, &uscfp[i]->host);
            ngxw_json_lit(&b, ":[");
            if (uscfp[i]->servers) {
                us = uscfp[i]->servers->elts;
                for (j = 0; j < uscfp[i]->servers->nelts; j++) {
                    ngx_uint_t a;
                    for (a = 0; a < us[j].naddrs; a++) {
                        if (j || a) {
                            ngxw_json_lit(&b, ",");
                        }
                        ngxw_json_str(&b, &us[j].addrs[a].name);
                    }
                }
            }
            ngxw_json_lit(&b, "]");
        }
    }

    ngxw_json_lit(&b, "}}");

done:

    out = malloc(b.len + 1);
    if (out == NULL) {
        ngxw_buf_free(&b);
        return NULL;
    }
    memcpy(out, b.data, b.len);
    out[b.len] = '\0';
    ngxw_buf_free(&b);

    return out;
}

EMSCRIPTEN_KEEPALIVE
u_char *
nginxw_out_take(int fd)
{
    ngxw_slot_t  *sl = ngxw_slot(fd);
    u_char       *p;

    if (sl == NULL) {
        return NULL;
    }

    p = sl->out.data + sl->out.off;
    sl->out.off = sl->out.len;

    return p;
}

EMSCRIPTEN_KEEPALIVE
void
nginxw_debug_conn(int fd)
{
    ngxw_slot_t  *sl = ngxw_slot(fd);

    if (sl && sl->c && sl->c->log) {
        sl->c->log->log_level |= NGX_LOG_DEBUG_CONNECTION | NGX_LOG_DEBUG_ALL;
    }
}

typedef struct {
    ngx_str_t  content_id;
    ngx_str_t  access_id;
} ngx_wasm_js_loc_conf_t;

typedef struct {
    unsigned   done:1;
    unsigned   allow:1;
    unsigned   waiting:1;
    ngx_uint_t status;
} ngx_wasm_js_ctx_t;

extern ngx_module_t  ngx_wasm_js_module;

#define NGXJS_SLOTS  256

static ngx_http_request_t  *ngxjs_req[NGXJS_SLOTS];
static unsigned             ngxjs_gen[NGXJS_SLOTS];
static ngx_uint_t           ngxjs_cursor;

static void
ngxjs_cleanup(void *data)
{
    int  token = (int) (intptr_t) data;
    int  idx = token & 0xff;

    if (idx >= 0 && idx < NGXJS_SLOTS
        && ngxjs_gen[idx] == (unsigned) ((unsigned) token >> 8))
    {
        ngxjs_req[idx] = NULL;
    }
}

static int
ngxjs_register(ngx_http_request_t *r)
{
    int                  i, idx, token;
    unsigned             gen;
    ngx_http_cleanup_t  *cln;

    for (i = 0; i < NGXJS_SLOTS; i++) {
        idx = (ngxjs_cursor + i) % NGXJS_SLOTS;
        if (ngxjs_req[idx] == NULL) {
            ngxjs_cursor = idx + 1;
            ngxjs_req[idx] = r;
            gen = ++ngxjs_gen[idx];
            token = (int) ((gen << 8) | (unsigned) idx);

            cln = ngx_http_cleanup_add(r, 0);
            if (cln) {
                cln->handler = ngxjs_cleanup;
                cln->data = (void *) (intptr_t) token;
            }
            return token;
        }
    }
    return -1;
}

static ngx_http_request_t *
ngxjs_lookup(int token)
{
    int  idx = token & 0xff;

    if (idx < 0 || idx >= NGXJS_SLOTS || ngxjs_req[idx] == NULL) {
        return NULL;
    }
    if (ngxjs_gen[idx] != (unsigned) ((unsigned) token >> 8)) {
        return NULL;
    }
    return ngxjs_req[idx];
}

static char *
ngxjs_strdup(ngx_str_t *s)
{
    char  *p = malloc(s->len + 1);

    if (p == NULL) {
        return NULL;
    }
    memcpy(p, s->data, s->len);
    p[s->len] = '\0';
    return p;
}

EMSCRIPTEN_KEEPALIVE
char *
nginxw_req_method(int token)
{
    ngx_http_request_t  *r = ngxjs_lookup(token);
    return r ? ngxjs_strdup(&r->method_name) : NULL;
}

EMSCRIPTEN_KEEPALIVE
char *
nginxw_req_uri(int token)
{
    ngx_http_request_t  *r = ngxjs_lookup(token);
    char                *out;
    size_t               n;

    if (r == NULL) {
        return NULL;
    }

    n = r->uri.len + (r->args.len ? 1 + r->args.len : 0);
    out = malloc(n + 1);
    if (out == NULL) {
        return NULL;
    }

    memcpy(out, r->uri.data, r->uri.len);
    if (r->args.len) {
        out[r->uri.len] = '?';
        memcpy(out + r->uri.len + 1, r->args.data, r->args.len);
    }
    out[n] = '\0';

    return out;
}

EMSCRIPTEN_KEEPALIVE
char *
nginxw_req_headers(int token)
{
    ngx_http_request_t  *r = ngxjs_lookup(token);
    ngx_list_part_t     *part;
    ngx_table_elt_t     *h;
    ngx_uint_t           i;
    size_t               total;
    char                *out, *p;

    if (r == NULL) {
        return NULL;
    }

    total = 1;
    part = &r->headers_in.headers.part;
    h = part->elts;
    for (i = 0;  ; i++) {
        if (i >= part->nelts) {
            if (part->next == NULL) {
                break;
            }
            part = part->next;
            h = part->elts;
            i = 0;
        }
        total += h[i].key.len + h[i].value.len + 4;
    }

    out = malloc(total);
    if (out == NULL) {
        return NULL;
    }
    p = out;

    part = &r->headers_in.headers.part;
    h = part->elts;
    for (i = 0;  ; i++) {
        if (i >= part->nelts) {
            if (part->next == NULL) {
                break;
            }
            part = part->next;
            h = part->elts;
            i = 0;
        }
        memcpy(p, h[i].key.data, h[i].key.len); p += h[i].key.len;
        *p++ = ':'; *p++ = ' ';
        memcpy(p, h[i].value.data, h[i].value.len); p += h[i].value.len;
        *p++ = '\r'; *p++ = '\n';
    }
    *p = '\0';

    return out;
}

EMSCRIPTEN_KEEPALIVE
char *
nginxw_req_var(int token, const char *name)
{
    ngx_http_request_t         *r = ngxjs_lookup(token);
    ngx_str_t                   n;
    ngx_uint_t                  hash;
    ngx_http_variable_value_t  *v;
    ngx_str_t                   val;

    if (r == NULL) {
        return NULL;
    }

    n.len = ngx_strlen(name);
    n.data = (u_char *) name;
    hash = ngx_hash_strlow(n.data, n.data, n.len);

    v = ngx_http_get_variable(r, &n, hash);
    if (v == NULL || v->not_found) {
        return NULL;
    }

    val.len = v->len;
    val.data = v->data;
    return ngxjs_strdup(&val);
}

EMSCRIPTEN_KEEPALIVE
int
nginxw_req_body_len(int token)
{
    ngx_http_request_t  *r = ngxjs_lookup(token);
    ngx_chain_t         *cl;
    off_t                len;

    if (r == NULL || r->request_body == NULL || r->request_body->bufs == NULL) {
        return 0;
    }

    len = 0;
    for (cl = r->request_body->bufs; cl; cl = cl->next) {
        len += ngx_buf_size(cl->buf);
    }
    return (int) len;
}

EMSCRIPTEN_KEEPALIVE
int
nginxw_req_body_copy(int token, u_char *dst, int cap)
{
    ngx_http_request_t  *r = ngxjs_lookup(token);
    ngx_chain_t         *cl;
    size_t               n, total;

    if (r == NULL || r->request_body == NULL || r->request_body->bufs == NULL) {
        return 0;
    }

    total = 0;
    for (cl = r->request_body->bufs; cl; cl = cl->next) {
        ngx_buf_t *b = cl->buf;

        if (b->in_file) {
            n = (size_t) (b->file_last - b->file_pos);
            if (total + n > (size_t) cap) {
                n = (size_t) cap - total;
            }
            ngx_read_file(b->file, dst + total, n, b->file_pos);
        } else {
            n = (size_t) (b->last - b->pos);
            if (total + n > (size_t) cap) {
                n = (size_t) cap - total;
            }
            memcpy(dst + total, b->pos, n);
        }
        total += n;
        if (total >= (size_t) cap) {
            break;
        }
    }
    return (int) total;
}

static void
ngxjs_add_headers(ngx_http_request_t *r, const char *block)
{
    const char       *p = block, *eol, *colon;
    ngx_table_elt_t  *h;
    size_t            nlen, vlen;

    while (p && *p) {
        eol = strstr(p, "\r\n");
        if (eol == NULL) {
            eol = p + strlen(p);
        }
        colon = memchr(p, ':', eol - p);
        if (colon) {
            const char *vs = colon + 1;
            while (vs < eol && (*vs == ' ' || *vs == '\t')) vs++;
            nlen = colon - p;
            vlen = eol - vs;

            if (nlen == sizeof("Content-Type") - 1
                && ngx_strncasecmp((u_char *) p, (u_char *) "Content-Type", nlen) == 0)
            {
                r->headers_out.content_type.len = vlen;
                r->headers_out.content_type.data = ngx_pnalloc(r->pool, vlen);
                if (r->headers_out.content_type.data) {
                    memcpy(r->headers_out.content_type.data, vs, vlen);
                }
                r->headers_out.content_type_lowcase = NULL;

            } else if (nlen == sizeof("Content-Length") - 1
                && ngx_strncasecmp((u_char *) p, (u_char *) "Content-Length", nlen) == 0)
            {

            } else {
                h = ngx_list_push(&r->headers_out.headers);
                if (h) {
                    h->hash = 1;
                    h->key.len = nlen;
                    h->key.data = ngx_pnalloc(r->pool, nlen);
                    h->value.len = vlen;
                    h->value.data = ngx_pnalloc(r->pool, vlen);
                    if (h->key.data && h->value.data) {
                        memcpy(h->key.data, p, nlen);
                        memcpy(h->value.data, vs, vlen);
                    }
                }
            }
        }

        if (*eol == '\0') {
            break;
        }
        p = eol + 2;
    }
}

EMSCRIPTEN_KEEPALIVE
int
nginxw_js_finish(int token, int status, const char *headers,
    const u_char *body, int body_len)
{
    ngx_http_request_t  *r = ngxjs_lookup(token);
    ngx_connection_t    *c;
    ngx_buf_t           *b;
    ngx_chain_t          out;
    ngx_int_t            rc;
    int                  idx;

    if (r == NULL) {
        return -1;
    }

    idx = token & 0xff;
    ngxjs_req[idx] = NULL;
    c = r->connection;

    ngx_time_update();

    r->headers_out.status = status;
    r->headers_out.content_length_n = body_len;

    if (headers && *headers) {
        ngxjs_add_headers(r, headers);
    }
    if (r->headers_out.content_type.len == 0) {
        ngx_str_set(&r->headers_out.content_type, "application/octet-stream");
    }

    rc = ngx_http_send_header(r);
    if (rc == NGX_ERROR || rc > NGX_OK || r->header_only) {
        ngx_http_finalize_request(r, rc);
        ngx_http_run_posted_requests(c);
        ngxw_drain();
        return 0;
    }

    b = ngx_calloc_buf(r->pool);
    if (b == NULL) {
        ngx_http_finalize_request(r, NGX_HTTP_INTERNAL_SERVER_ERROR);
        ngx_http_run_posted_requests(c);
        ngxw_drain();
        return 0;
    }
    if (body_len > 0) {
        b->pos = ngx_pnalloc(r->pool, body_len);
        if (b->pos == NULL) {
            ngx_http_finalize_request(r, NGX_HTTP_INTERNAL_SERVER_ERROR);
            ngx_http_run_posted_requests(c);
            ngxw_drain();
            return 0;
        }
        ngx_memcpy(b->pos, body, body_len);
        b->last = b->pos + body_len;
        b->memory = 1;
    } else {
        b->sync = 1;
    }
    b->last_buf = 1;
    b->last_in_chain = 1;

    out.buf = b;
    out.next = NULL;

    rc = ngx_http_output_filter(r, &out);
    ngx_http_finalize_request(r, rc);
    ngx_http_run_posted_requests(c);
    ngxw_drain();

    return 0;
}

EMSCRIPTEN_KEEPALIVE
int
nginxw_js_send_head(int token, int status, const char *headers)
{
    ngx_http_request_t  *r = ngxjs_lookup(token);
    ngx_connection_t    *c;
    ngx_int_t            rc;

    if (r == NULL) {
        return -1;
    }

    c = r->connection;

    ngx_time_update();

    r->headers_out.status = status;
    r->headers_out.content_length_n = -1;

    if (headers && *headers) {
        ngxjs_add_headers(r, headers);
    }
    if (r->headers_out.content_type.len == 0) {
        ngx_str_set(&r->headers_out.content_type, "application/octet-stream");
    }

    rc = ngx_http_send_header(r);
    if (rc == NGX_ERROR || rc > NGX_OK) {

        ngxjs_req[token & 0xff] = NULL;
        ngx_http_finalize_request(r, rc);
        ngx_http_run_posted_requests(c);
        ngxw_drain();
        return -2;
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int
nginxw_js_send_chunk(int token, const u_char *data, int len)
{
    ngx_http_request_t  *r = ngxjs_lookup(token);
    ngx_buf_t           *b;
    ngx_chain_t          out;

    if (r == NULL) {
        return -1;
    }
    if (len <= 0) {
        return 0;
    }

    ngx_time_update();

    b = ngx_calloc_buf(r->pool);
    if (b == NULL) {
        return -2;
    }
    b->pos = ngx_pnalloc(r->pool, len);
    if (b->pos == NULL) {
        return -2;
    }
    ngx_memcpy(b->pos, data, len);
    b->last = b->pos + len;
    b->memory = 1;
    b->flush = 1;

    out.buf = b;
    out.next = NULL;

    ngx_http_output_filter(r, &out);

    return (int) (r->connection->buffered ? 1 : 0);
}

EMSCRIPTEN_KEEPALIVE
int
nginxw_js_send_end(int token)
{
    ngx_http_request_t  *r = ngxjs_lookup(token);
    ngx_connection_t    *c;
    ngx_buf_t           *b;
    ngx_chain_t          out;
    ngx_int_t            rc;
    int                  idx;

    if (r == NULL) {
        return -1;
    }
    idx = token & 0xff;
    ngxjs_req[idx] = NULL;
    c = r->connection;

    ngx_time_update();

    b = ngx_calloc_buf(r->pool);
    if (b == NULL) {
        ngx_http_finalize_request(r, NGX_HTTP_INTERNAL_SERVER_ERROR);
        ngx_http_run_posted_requests(c);
        ngxw_drain();
        return 0;
    }
    b->last_buf = 1;
    b->last_in_chain = 1;
    b->sync = 1;

    out.buf = b;
    out.next = NULL;

    rc = ngx_http_output_filter(r, &out);
    ngx_http_finalize_request(r, rc);
    ngx_http_run_posted_requests(c);
    ngxw_drain();

    return 0;
}

EMSCRIPTEN_KEEPALIVE
int
nginxw_js_fail(int token, int status)
{
    ngx_http_request_t  *r = ngxjs_lookup(token);
    ngx_connection_t    *c;
    int                  idx;

    if (r == NULL) {
        return -1;
    }
    idx = token & 0xff;
    ngxjs_req[idx] = NULL;
    c = r->connection;

    ngx_time_update();
    ngx_http_finalize_request(r, status ? status : NGX_HTTP_INTERNAL_SERVER_ERROR);
    ngx_http_run_posted_requests(c);
    ngxw_drain();
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int
nginxw_js_access_finish(int token, int status)
{
    ngx_http_request_t  *r = ngxjs_lookup(token);
    ngx_connection_t    *c;
    ngx_wasm_js_ctx_t   *ctx;
    int                  idx;

    if (r == NULL) {
        return -1;
    }

    idx = token & 0xff;
    ngxjs_req[idx] = NULL;
    c = r->connection;

    ctx = ngx_http_get_module_ctx(r, ngx_wasm_js_module);
    if (ctx) {
        ctx->done = 1;
        ctx->waiting = 0;
        ctx->allow = (status >= 200 && status < 300);
        ctx->status = (ngx_uint_t) status;
    }

    ngx_time_update();

    ngx_http_core_run_phases(r);
    ngx_http_run_posted_requests(c);
    ngxw_drain();

    return 0;
}

static ngx_int_t
ngx_wasm_js_access_handler(ngx_http_request_t *r)
{
    ngx_wasm_js_loc_conf_t  *jlcf;
    ngx_wasm_js_ctx_t       *ctx;
    char                     id[128];
    int                      token;
    size_t                   n;

    jlcf = ngx_http_get_module_loc_conf(r, ngx_wasm_js_module);
    if (jlcf->access_id.len == 0) {
        return NGX_DECLINED;
    }

    ctx = ngx_http_get_module_ctx(r, ngx_wasm_js_module);
    if (ctx == NULL) {
        ctx = ngx_pcalloc(r->pool, sizeof(ngx_wasm_js_ctx_t));
        if (ctx == NULL) {
            return NGX_HTTP_INTERNAL_SERVER_ERROR;
        }
        ngx_http_set_ctx(r, ctx, ngx_wasm_js_module);
    }

    if (ctx->done) {
        return ctx->allow ? NGX_OK : (ngx_int_t) ctx->status;
    }
    if (ctx->waiting) {
        return NGX_DONE;
    }

    token = ngxjs_register(r);
    if (token < 0) {
        return NGX_HTTP_INTERNAL_SERVER_ERROR;
    }
    ctx->waiting = 1;

    n = jlcf->access_id.len < sizeof(id) - 1 ? jlcf->access_id.len : sizeof(id) - 1;
    memcpy(id, jlcf->access_id.data, n);
    id[n] = '\0';

    ngxw_js_invoke_access(id, token);

    return NGX_DONE;
}

static void
ngx_wasm_js_body_handler(ngx_http_request_t *r)
{
    ngx_wasm_js_loc_conf_t  *jlcf;
    char                     id[128];
    int                      token;
    size_t                   n;

    jlcf = ngx_http_get_module_loc_conf(r, ngx_wasm_js_module);

    token = ngxjs_register(r);
    if (token < 0) {
        ngx_http_finalize_request(r, NGX_HTTP_INTERNAL_SERVER_ERROR);
        return;
    }

    n = jlcf->content_id.len < sizeof(id) - 1 ? jlcf->content_id.len : sizeof(id) - 1;
    memcpy(id, jlcf->content_id.data, n);
    id[n] = '\0';

    ngxw_js_invoke_handler(id, token);
}

static ngx_int_t
ngx_wasm_js_content_handler(ngx_http_request_t *r)
{
    ngx_int_t  rc;

    rc = ngx_http_read_client_request_body(r, ngx_wasm_js_body_handler);
    if (rc >= NGX_HTTP_SPECIAL_RESPONSE) {
        return rc;
    }
    return NGX_DONE;
}

static void *
ngx_wasm_js_create_loc_conf(ngx_conf_t *cf)
{

    return ngx_pcalloc(cf->pool, sizeof(ngx_wasm_js_loc_conf_t));
}

static char *
ngx_wasm_js_merge_loc_conf(ngx_conf_t *cf, void *parent, void *child)
{
    ngx_wasm_js_loc_conf_t  *prev = parent;
    ngx_wasm_js_loc_conf_t  *conf = child;

    ngx_conf_merge_str_value(conf->content_id, prev->content_id, "");
    ngx_conf_merge_str_value(conf->access_id, prev->access_id, "");
    return NGX_CONF_OK;
}

static char *
ngx_wasm_js_content(ngx_conf_t *cf, ngx_command_t *cmd, void *conf)
{
    ngx_wasm_js_loc_conf_t    *jlcf = conf;
    ngx_http_core_loc_conf_t  *clcf;
    ngx_str_t                 *value = cf->args->elts;

    jlcf->content_id = value[1];

    clcf = ngx_http_conf_get_module_loc_conf(cf, ngx_http_core_module);
    clcf->handler = ngx_wasm_js_content_handler;

    return NGX_CONF_OK;
}

static char *
ngx_wasm_js_access(ngx_conf_t *cf, ngx_command_t *cmd, void *conf)
{
    ngx_wasm_js_loc_conf_t  *jlcf = conf;
    ngx_str_t               *value = cf->args->elts;

    jlcf->access_id = value[1];
    return NGX_CONF_OK;
}

static ngx_int_t
ngx_wasm_js_init(ngx_conf_t *cf)
{
    ngx_http_handler_pt        *h;
    ngx_http_core_main_conf_t  *cmcf;

    cmcf = ngx_http_conf_get_module_main_conf(cf, ngx_http_core_module);

    h = ngx_array_push(&cmcf->phases[NGX_HTTP_ACCESS_PHASE].handlers);
    if (h == NULL) {
        return NGX_ERROR;
    }
    *h = ngx_wasm_js_access_handler;

    return NGX_OK;
}

static ngx_command_t  ngx_wasm_js_commands[] = {

    { ngx_string("wasm_js_content"),
      NGX_HTTP_LOC_CONF | NGX_CONF_TAKE1,
      ngx_wasm_js_content,
      NGX_HTTP_LOC_CONF_OFFSET,
      0,
      NULL },

    { ngx_string("wasm_js_access"),
      NGX_HTTP_SRV_CONF | NGX_HTTP_LOC_CONF | NGX_CONF_TAKE1,
      ngx_wasm_js_access,
      NGX_HTTP_LOC_CONF_OFFSET,
      0,
      NULL },

    ngx_null_command
};

static ngx_http_module_t  ngx_wasm_js_module_ctx = {
    NULL,
    ngx_wasm_js_init,
    NULL,
    NULL,
    NULL,
    NULL,
    ngx_wasm_js_create_loc_conf,
    ngx_wasm_js_merge_loc_conf
};

ngx_module_t  ngx_wasm_js_module = {
    NGX_MODULE_V1,
    &ngx_wasm_js_module_ctx,
    ngx_wasm_js_commands,
    NGX_HTTP_MODULE,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NGX_MODULE_V1_PADDING
};
