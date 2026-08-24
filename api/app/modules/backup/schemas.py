"""Contratos do backup.

A regra que manda em tudo aqui: **o token nunca sai**. Ele é uma credencial do Google —
quem o tiver escreve e apaga no Drive da loja. A tela só precisa saber SE existe, não
qual é. Por isso `BackupOut` tem `configurado: bool` e não tem campo de token.
"""

from datetime import datetime

from pydantic import BaseModel, Field, field_validator


class BackupOut(BaseModel):
    ativo: bool
    #: Existe token gravado? A tela decide entre "Configurar" e "Trocar a conta" com isto.
    configurado: bool
    pasta: str
    manter: int
    intervalo_min: int

    ultimo_em: datetime | None = None
    ultimo_ok: bool | None = None
    ultimo_erro: str | None = None
    ultimo_bytes: int | None = None
    copias_na_nuvem: int | None = None

    @classmethod
    def de_modelo(cls, c) -> "BackupOut":  # noqa: ANN001
        return cls(
            ativo=c.ativo,
            configurado=bool(c.rclone_token),
            pasta=c.pasta,
            manter=c.manter,
            intervalo_min=c.intervalo_min,
            ultimo_em=c.ultimo_em,
            ultimo_ok=c.ultimo_ok,
            ultimo_erro=c.ultimo_erro,
            ultimo_bytes=c.ultimo_bytes,
            copias_na_nuvem=c.copias_na_nuvem,
        )


class BackupUpdate(BaseModel):
    """Tudo opcional: ligar/desligar não deve exigir reenviar o token."""

    ativo: bool | None = None
    #: O JSON inteiro que o `rclone authorize "drive"` imprime. Entra, nunca sai.
    rclone_token: str | None = None
    pasta: str | None = Field(default=None, min_length=1, max_length=120)
    manter: int | None = Field(default=None, ge=2, le=200)
    intervalo_min: int | None = Field(default=None, ge=5, le=1440)

    @field_validator("rclone_token")
    @classmethod
    def _token_parece_token(cls, v: str | None) -> str | None:
        if v is None:
            return None
        limpo = v.strip()
        if not limpo:
            return None
        # O `rclone authorize` imprime um JSON com `access_token` e `refresh_token`.
        # Conferir aqui evita o pior caso: alguém cola o texto errado, a tela diz
        # "configurado", e a loja passa semanas achando que tem backup.
        if not (limpo.startswith("{") and "refresh_token" in limpo):
            raise ValueError(
                'Isso não parece o token do rclone. Cole o JSON inteiro que apareceu '
                'depois de rodar: rclone authorize "drive"'
            )
        return limpo

    @field_validator("pasta")
    @classmethod
    def _pasta_sem_barra(cls, v: str | None) -> str | None:
        if v is None:
            return None
        limpo = v.strip().strip("/")
        if not limpo:
            raise ValueError("A pasta não pode ser vazia.")
        return limpo
