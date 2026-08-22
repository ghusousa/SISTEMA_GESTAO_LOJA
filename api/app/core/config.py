"""Configuração da aplicação (12-factor: tudo por variável de ambiente)."""

from functools import lru_cache
from typing import Annotated
from zoneinfo import ZoneInfo

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


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
    jwt_secret: str = "troque-esta-chave-em-producao"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 30
    refresh_token_expire_days: int = 30

    # Origens liberadas no CORS, separadas por vírgula no .env (NoDecode: não é JSON).
    cors_origins: Annotated[list[str], NoDecode] = Field(default_factory=lambda: ["*"])

    # Fuso do comércio: define o que é "o dia" nos relatórios e no fechamento de caixa.
    timezone_loja: str = "America/Sao_Paulo"

    media_dir: str = "media"
    max_upload_bytes: int = 5 * 1024 * 1024

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, v: object) -> object:
        if isinstance(v, str):
            return [item.strip() for item in v.split(",") if item.strip()]
        return v

    @property
    def tz_loja(self) -> ZoneInfo:
        return ZoneInfo(self.timezone_loja)


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
