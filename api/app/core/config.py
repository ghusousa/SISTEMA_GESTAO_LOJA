"""Configuração da aplicação (12-factor: tudo por variável de ambiente)."""

from functools import lru_cache
from typing import Annotated
from zoneinfo import ZoneInfo

from pydantic import Field, field_validator, model_validator
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


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
