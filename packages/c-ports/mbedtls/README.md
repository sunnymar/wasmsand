# mbedTLS c-port

Codepod C port for mbedTLS 3.6.6 LTS.

This builds static mbedTLS archives with the Codepod C toolchain for curl
socket-mode HTTPS. The curl fetch transport does not use mbedTLS.

Build:

```bash
make -C packages/c-ports/mbedtls copy-fixtures
```
