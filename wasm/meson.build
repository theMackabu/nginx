project(
  'nginx-wasm',
  'c',
  version: '0.2.0',
  license: 'BSD-2-Clause',
  meson_version: '>=1.1',
  default_options: ['default_library=static', 'buildtype=release'],
)

fs = import('fs')

nginx_root = fs.parent(meson.current_source_dir())
mime_types = files('../conf/mime.types')
is_wasm = meson.is_cross_build() and host_machine.cpu_family() == 'wasm32'

pcre2_sp = subproject('pcre2', default_options: ['grep=false', 'test=false'])
pcre2_lib = pcre2_sp.get_variable('pcre2_8_lib')

zlib_sp = subproject('zlib')
zlib_lib = zlib_sp.get_variable('zlib')

openssl_sp = subproject('openssl', default_options: ['asm=disabled', 'build_cli=false'])
libssl = openssl_sp.get_variable('libssl_lib')
libcrypto = openssl_sp.get_variable('libcrypto_lib')

pcre2_version = fs.name(fs.parent(pcre2_lib.full_path())).split('-')[1]
zlib_version = fs.name(fs.parent(zlib_lib.full_path())).split('-')[1]
openssl_version = fs.name(fs.parent(libssl.full_path())).split('-')[1]

bash = find_program('bash')

build_nginx = files('tools/build-nginx.sh')

if is_wasm
  nginx_objs = custom_target(
    'nginx-wasm-objs',
    output: 'nginx-wasm-objs.stamp',
    command: [
      bash, build_nginx, 'wasm', nginx_root, '@OUTPUT@',
      pcre2_lib.full_path(), zlib_lib.full_path(),
      libssl.full_path(), libcrypto.full_path(),
    ],
    depends: [pcre2_lib, zlib_lib, libssl, libcrypto],
    build_always_stale: true,
    console: true,
  )

  custom_target(
    'nginx-mjs',
    output: 'nginx.mjs',
    input: nginx_objs,
    command: [
      bash, files('tools/link-wasm.sh'),
      nginx_root, '@OUTPUT@',
      pcre2_lib.full_path(), zlib_lib.full_path(),
      libssl.full_path(), libcrypto.full_path(),
      pcre2_version, zlib_version, openssl_version,
    ],
    depends: [pcre2_lib, zlib_lib, libssl, libcrypto],
    depend_files: mime_types,
    build_by_default: true,
    console: true,
  )
else
  custom_target(
    'nginx-native',
    output: 'nginx-native.stamp',
    command: [
      bash, build_nginx, 'native', nginx_root, '@OUTPUT@',
      pcre2_lib.full_path(), zlib_lib.full_path(),
      libssl.full_path(), libcrypto.full_path(),
    ],
    depends: [pcre2_lib, zlib_lib, libssl, libcrypto],
    build_always_stale: true,
    build_by_default: true,
    console: true,
  )
endif
