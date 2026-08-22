from pydantic import BaseModel, EmailStr, Field

from app.modules.usuarios.schemas import UsuarioOut


class LoginIn(BaseModel):
    email: EmailStr
    senha: str = Field(min_length=1, max_length=72)


class RefreshIn(BaseModel):
    refresh_token: str


class TokenOut(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int  # segundos de validade do access token
    usuario: UsuarioOut
