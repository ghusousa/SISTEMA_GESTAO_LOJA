# Imagem da API, que também entrega o sistema web.
#
# O `web/` entra na imagem porque quem serve a página é o próprio FastAPI (ADR-11): uma
# imagem, um container, nada de processo Node em produção.

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv/api

# Certificado extra, para redes que inspecionam HTTPS (proxy corporativo, alguns
# antivírus). Sem isto o pip morre com "certificate verify failed" e a mensagem não deixa
# claro que o problema é a rede, não o projeto. Pasta vazia: o build ignora.
COPY docker/certificados/ /usr/local/share/ca-certificates/
RUN if ls /usr/local/share/ca-certificates/*.crt >/dev/null 2>&1; then \
        update-ca-certificates; \
    fi

# As dependências vêm antes do código: mexer numa view não reinstala o SQLAlchemy inteiro.
# A lista sai do próprio pyproject.toml, para não existir uma segunda cópia que envelhece.
COPY api/pyproject.toml ./
RUN python -c "import tomllib, pathlib; \
    deps = tomllib.load(open('pyproject.toml','rb'))['project']['dependencies']; \
    pathlib.Path('/tmp/req.txt').write_text('\n'.join(deps))" \
    && PIP_CERT=/etc/ssl/certs/ca-certificates.crt pip install --no-cache-dir -r /tmp/req.txt \
    && rm /tmp/req.txt

COPY api/ /srv/api/
COPY web/ /srv/web/
COPY docker/entrada.sh /usr/local/bin/entrada.sh

# Rodar como root dentro do container é risco desnecessário: se a aplicação for
# comprometida, o atacante começa sem privilégio.
RUN chmod +x /usr/local/bin/entrada.sh \
    && useradd --system --uid 10001 loja \
    && mkdir -p /srv/media \
    && chown -R loja /srv/media

USER loja
EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/entrada.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
