"""Configuração da aplicação (12-factor: tudo por variável de ambiente)."""

from functools import lru_cache
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

# Valor de exemplo do .env.example. Serve para desenvolvimento e é recusado em produção:
# subir com ele significaria aceitar qualquer token forjado com um segredo público.
JWT_SECRET_EXEMPLO = "troque-esta-chave-em-producao"


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

    @property
    def fotos_no_blob(self) -> bool:
        """A foto da peça vai para o Vercel Blob (e não para MEDIA_DIR)? ADR-42."""
        return bool(self.blob_read_write_token.get_secret_value().strip())


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
