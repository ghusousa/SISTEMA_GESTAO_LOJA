"""Configuração da aplicação (12-factor: tudo por variável de ambiente)."""

import hashlib
import hmac
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

from app.core.url_do_banco import argumentos_de_conexao, preparar_url

# Valor de exemplo do .env.example. Serve para desenvolvimento e é recusado em produção:
# subir com ele significaria aceitar qualquer token forjado com um segredo público.
JWT_SECRET_EXEMPLO = "troque-esta-chave-em-producao"
#: Senha de banco curta ou conhecida não vira segredo de login: derivar dela daria um
#: segredo que qualquer um calcula (a da loja local é "postgres").
SENHA_MINIMA_PARA_DERIVAR = 12


def segredo_derivado_do_banco(url: str, *, informado: bool) -> str | None:
    """HMAC-SHA256 da senha do banco, com rótulo próprio, para assinar os tokens (ADR-42).

    Só na Vercel, e só quando o banco foi informado e tem senha forte. Devolve None quando
    não há de onde derivar — e aí vale a regra de sempre: sem JWT_SECRET, não sobe.
    """
    if not informado:
        return None
    senha = urlsplit(url).password or ""
    if len(senha) < SENHA_MINIMA_PARA_DERIVAR:
        return None
    return hmac.new(senha.encode(), b"sistema-gestao-loja/jwt/v1", hashlib.sha256).hexdigest()


#: A pasta `api/`, de onde quer que o processo rode (uvicorn na mão, Docker ou Vercel).
PASTA_API = Path(__file__).resolve().parents[2]
#: Para onde o build da Vercel copia o sistema web: a função só empacota o que está DENTRO
#: do Root Directory (`api/`), e o `web/` mora ao lado dele no repositório (ADR-42).
PASTA_WEB_NA_VERCEL = PASTA_API / "web_vercel"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    app_name: str = "Gestão Loja API"
    ambiente: str = "dev"
    debug: bool = False

    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/loja"
    db_echo: bool = False
    #: Teto de cada consulta da API, em milissegundos (0 = sem teto). O app desiste em 15 s
    #: e o retry dispara a MESMA consulta de novo; sem teto no banco, a primeira continua
    #: rodando sozinha e as duas disputam o mini-PC da loja — foi assim que a tela de
    #: Clientes, sem índice, prendia o banco por 70 s a cada abertura. Vale só para as
    #: conexões da API: a migration e o pg_dump usam conexão própria e não herdam o teto.
    db_statement_timeout_ms: int = 30_000
    #: A conexão DIRETA do Neon que a Vercel injeta (ADR-42). Quando existe, ganha da
    #: DATABASE_URL (que lá passa pelo PgBouncer em modo transação): conexão direta mantém o
    #: cache de prepared statements e aceita o `statement_timeout` na partida. A escuta do
    #: tempo real também usa (`core/escuta.py`): LISTEN atrás de PgBouncer em modo transação
    #: não recebe nada, e calado.
    database_url_unpooled: str = ""
    #: `ssl=` do asyncpg. Vazio = o que a URL pedir no `sslmode` (o Neon pede `require`);
    #: a da loja não pede nada, e fica como sempre foi. A escuta do tempo real segue este
    #: modo (`dsn_da_escuta()`): a conexão de LISTEN não pode ser menos protegida que a do app.
    db_ssl: str = ""
    #: A URL passa por um PgBouncer em modo transação. Ligado sozinho quando o host tem
    #: `-pooler` (Neon); ver `url_do_banco.py`.
    db_pooler: bool = False
    #: Conexões que cada processo da API mantém abertas, e quantas a mais aceita no pico.
    #: Na loja é um processo só; na Vercel cada instância da função tem o seu pool, por isso
    #: lá o padrão é pequeno (ver `_padroes_da_vercel`).
    db_pool_size: int = Field(default=10, ge=1)
    db_max_overflow: int = Field(default=20, ge=0)

    # Segurança. Em produção JWT_SECRET é obrigatório e vem do .env (nunca do código).
    jwt_secret: str = JWT_SECRET_EXEMPLO
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 30
    refresh_token_expire_days: int = 30

    # Origens liberadas no CORS, separadas por vírgula no .env (NoDecode: não é JSON).
    cors_origins: Annotated[list[str], NoDecode] = Field(default_factory=lambda: ["*"])

    # Fuso do comércio: define o que é "o dia" nos relatórios e no fechamento de caixa.
    timezone_loja: str = "America/Sao_Paulo"

    media_dir: str = "media"
    #: Onde mora o sistema web (HTML e módulos ES). Vazio = `web/` ao lado de `api/`, que é o
    #: lugar dele no repositório e na imagem Docker; na Vercel, a cópia que o build faz.
    web_dir: str = ""
    #: Onde o ./atualizar.sh deixa o que sabe sobre a versão instalada. É o único
    #: caminho por onde a API descobre se existe coisa nova — ela nunca fala com o
    #: GitHub, para não precisar de credencial do repositório dentro do contêiner.
    estado_dir: str = "estado"
    max_upload_bytes: int = 5 * 1024 * 1024
    #: Fotos no Vercel Blob (ADR-42). Vazio (padrão) = disco em MEDIA_DIR, como sempre.
    #: Presente, a foto vai para o store PÚBLICO e o banco guarda a URL absoluta dela.
    #: `SecretStr`: escreve no store da loja, não sai em `repr` nem em log.
    blob_read_write_token: SecretStr = SecretStr("")
    #: O mesmo padrão (e a mesma variável) do SDK oficial do Blob.
    vercel_blob_api_url: str = "https://vercel.com/api/blob"

    #: Quantos dias o diário de auditoria guarda (0 = para sempre). A faxina é oportunista,
    #: no login certo, como a das tentativas de login. O diário prova quem fez o quê; não
    #: é livro fiscal (esse é a própria venda, que não sai daqui), e e-mail e IP de cada
    #: tentativa guardados para sempre são dado pessoal sem finalidade (ADR-23).
    retencao_auditoria_dias: int = Field(default=730, ge=0)

    # NFC-e (ADR-41). O emissor é contratado pelo dono e ligado AQUI, no .env da máquina —
    # nunca na tela nem no banco. Mesma régua do backup (ADR-28) e do token do GitHub: a
    # credencial que assina nota em nome do CNPJ da loja não passa por rota nenhuma, não
    # entra no backup e não aparece para ninguém logado, nem para o dono.
    #: "desligado" (padrão) ou o nome de um adaptador de `modules/fiscal/emissores.py`.
    #: Valor desconhecido derruba o boot: emissor com nome errado é nota que não sai.
    fiscal_emissor: Literal["desligado", "focusnfe"] = "desligado"
    #: Token da empresa no painel da Focus NFe. `SecretStr`: não sai nem num `repr`/log.
    focusnfe_token: SecretStr = SecretStr("")
    #: Homologação primeiro, sempre: nota de homologação não tem valor fiscal.
    focusnfe_ambiente: Literal["homologacao", "producao"] = "homologacao"
    #: Emitir sozinho logo depois de cada venda, fora da transação dela. Desligado, a nota
    #: sai pelo botão "Emitir NFC-e" do detalhe da venda.
    fiscal_emitir_automatico: bool = False

    # Vercel (ADR-42): variáveis de SISTEMA que a própria Vercel põe no build e na função.
    # Fora dela nenhuma existe, e é por isso que a loja não muda nada: tudo o que depende
    # delas fica atrás de `if self.vercel`.
    vercel: bool = False
    vercel_env: str = ""
    vercel_url: str = ""
    vercel_branch_url: str = ""
    vercel_project_production_url: str = ""
    vercel_git_commit_sha: str = ""
    #: O dono da demonstração (a mesma variável que o build usa para criá-lo, ADR-42). Na
    #: Vercel, a conta deste e-mail não se exclui, não perde o papel, não é desativada e não
    #: troca de senha: é a conta das notas da revisão da App Store, e o revisor seguinte
    #: precisa entrar com ela (ADR-45). Fora da Vercel não vale nada.
    demo_admin_email: str = ""

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, v: object) -> object:
        if isinstance(v, str):
            return [item.strip() for item in v.split(",") if item.strip()]
        return v

    @field_validator("timezone_loja")
    @classmethod
    def _fuso_existe(cls, v: str) -> str:
        # Falhar no boot é melhor que descobrir o fuso inválido no primeiro relatório —
        # e este valor entra na expressão do índice funcional de data.
        try:
            ZoneInfo(v)
        except Exception as exc:
            raise ValueError(f"TIMEZONE_LOJA inválido: {v!r}") from exc
        return v

    @model_validator(mode="after")
    def _padroes_da_vercel(self) -> "Settings":
        """Na Vercel, o padrão de cada campo que o dono não escreveu é o que serve LÁ.

        Roda antes da checagem de segurança, de propósito: esquecer o AMBIENTE no painel da
        Vercel não pode subir a demonstração em modo desenvolvimento — com a documentação
        aberta, CORS `*` e aceitando o JWT_SECRET de exemplo, que está no repositório. O que
        o dono escreveu sempre ganha (`model_fields_set`).
        """
        if not self.web_dir:
            self.web_dir = str(PASTA_WEB_NA_VERCEL if self.vercel else PASTA_API.parent / "web")
        if not self.vercel:
            return self

        definidos = self.model_fields_set
        if "ambiente" not in definidos:
            self.ambiente = "producao"
        if "jwt_secret" not in definidos:
            # Sem JWT_SECRET no painel, o segredo do login sai da senha do banco que o Neon
            # injetou: segredo que só o deploy tem, nunca impresso, igual em toda instância.
            # Quem lê a senha do banco já lê tudo; o HMAC com rótulo próprio só não deixa o
            # token e o banco usarem a MESMA chave. Sem banco conectado (ou com a senha de
            # exemplo da loja), não deriva nada e a checagem abaixo recusa subir (ADR-42).
            derivado = segredo_derivado_do_banco(
                self.database_url_unpooled or self.database_url,
                informado="database_url" in definidos or "database_url_unpooled" in definidos,
            )
            if derivado:
                self.jwt_secret = derivado
        if "cors_origins" not in definidos:
            # A página e a API são a mesma origem; a lista só existe porque `*` é recusado
            # fora de desenvolvimento. Os três endereços que a Vercel dá a um deploy.
            enderecos = (
                self.vercel_project_production_url,
                self.vercel_url,
                self.vercel_branch_url,
            )
            origens = [f"https://{e}" for e in dict.fromkeys(enderecos) if e]
            if origens:
                self.cors_origins = origens
        if "media_dir" not in definidos:
            # O disco da função é somente leitura; só o /tmp grava (e não sobrevive à
            # instância). Sem isto a API morre no import, no mkdir da pasta de fotos.
            self.media_dir = "/tmp/media"
        if "db_pool_size" not in definidos:
            self.db_pool_size = 2
        if "db_max_overflow" not in definidos:
            self.db_max_overflow = 3
        # NFC-e automática roda DEPOIS de responder a venda, numa tarefa solta (ADR-41). Na
        # função da Vercel a instância pode congelar assim que a resposta sai, e a nota
        # ficaria pela metade: lá ela sai só pelo botão "Emitir NFC-e".
        self.fiscal_emitir_automatico = False
        return self

    @model_validator(mode="after")
    def _url_do_banco(self) -> "Settings":
        """A URL que o asyncpg entende, venha ela do `.env` da loja ou do Neon (ADR-42)."""
        conexao = preparar_url(self.database_url_unpooled or self.database_url)
        self.database_url = conexao.url
        if conexao.ssl and not self.db_ssl:
            self.db_ssl = conexao.ssl
        if conexao.pooler:
            self.db_pooler = True
        return self

    @model_validator(mode="after")
    def _seguranca_de_producao(self) -> "Settings":
        """Fora de desenvolvimento, o app não sobe com configuração insegura.

        Um deploy sem JWT_SECRET aceitaria qualquer token assinado com o segredo de exemplo,
        que está no repositório — isto é, acesso de administrador sem senha.
        """
        if self.ambiente.lower() in {"dev", "test", "local"}:
            return self

        if self.jwt_secret == JWT_SECRET_EXEMPLO or len(self.jwt_secret) < 32:
            raise ValueError(
                "JWT_SECRET ausente, de exemplo ou curto demais. Gere um com: "
                'python -c "import secrets; print(secrets.token_urlsafe(48))"'
            )
        if "*" in self.cors_origins:
            raise ValueError(
                "CORS_ORIGINS='*' não é aceito fora de desenvolvimento. "
                "Liste as origens reais separadas por vírgula."
            )
        if self.debug:
            raise ValueError("DEBUG=true não é aceito fora de desenvolvimento.")
        return self

    @property
    def tz_loja(self) -> ZoneInfo:
        return ZoneInfo(self.timezone_loja)

    @property
    def producao(self) -> bool:
        """Está servindo a loja de verdade? (qualquer ambiente que não seja dev/test/local)."""
        return self.ambiente.lower() not in {"dev", "test", "local"}

    def connect_args(self, *, com_teto: bool = True) -> dict[str, Any]:
        """`connect_args` do engine: teto por consulta, SSL e o modo PgBouncer.

        `com_teto=False` é a migration: ela usa conexão própria e não herda o teto.
        """
        return argumentos_de_conexao(
            ssl=self.db_ssl,
            pooler=self.db_pooler,
            statement_timeout_ms=self.db_statement_timeout_ms if com_teto else None,
        )

    @property
    def fotos_no_blob(self) -> bool:
        """A foto da peça vai para o Vercel Blob (e não para MEDIA_DIR)? ADR-42."""
        return bool(self.blob_read_write_token.get_secret_value().strip())


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
