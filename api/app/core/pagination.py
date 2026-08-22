"""Paginação padrão de todas as listagens: ?page=&size= -> {items, total, page, size}."""

from dataclasses import dataclass
from typing import Generic, TypeVar

from fastapi import Query
from pydantic import BaseModel

T = TypeVar("T")

MAX_SIZE = 100


@dataclass(frozen=True)
class Paginacao:
    page: int
    size: int

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.size

    @property
    def limit(self) -> int:
        return self.size


def paginacao(
    page: int = Query(1, ge=1, description="Página, começando em 1"),
    size: int = Query(20, ge=1, le=MAX_SIZE, description="Itens por página (máx. 100)"),
) -> Paginacao:
    return Paginacao(page=page, size=size)


class Pagina(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    size: int

    @classmethod
    def montar(cls, items: list[T], total: int, p: Paginacao) -> "Pagina[T]":
        return cls(items=items, total=total, page=p.page, size=p.size)
