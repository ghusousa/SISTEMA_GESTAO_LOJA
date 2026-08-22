# Certificados extras

Deixe esta pasta vazia se a sua rede é normal.

Se a empresa ou o provedor **inspeciona o tráfego HTTPS** (proxy corporativo, alguns
antivírus, firewalls de rede grande), o build quebra assim:

```
SSLError: certificate verify failed: self-signed certificate in certificate chain
ERROR: Could not find a version that satisfies the requirement fastapi
```

Não é erro do projeto: o `pip` dentro do container não conhece o certificado que a rede usa
para abrir a conexão. A correção é colocar esse certificado aqui, com extensão `.crt`, e
construir de novo:

```bash
cp certificado-da-empresa.crt docker/certificados/
./instalar.sh --forcar
```

Peça o arquivo a quem cuida da rede. Os `.crt` desta pasta não são versionados.
