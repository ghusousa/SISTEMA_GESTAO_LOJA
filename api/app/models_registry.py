"""Importa todos os modelos para que o Alembic enxergue o schema completo.

Um modelo que não estiver aqui simplesmente não entra nas migrations.
"""

from app.core.db import Base
from app.modules.auditoria.models import AuditLog
from app.modules.backup.models import BackupConfig
from app.modules.configuracao.models import StoreConfig
from app.modules.auth.models import LoginAttempt, RefreshToken
from app.modules.caixa.models import CashClosing, CashClosingLine
from app.modules.catalogo.models import Category, Product, ProductVariant
from app.modules.clientes.models import Customer, CustomerPayment
from app.modules.despesas.models import Expense, ExpenseCategory
from app.modules.estoque.models import StockBalance, StockEntry, StockMovement
from app.modules.fiscal.models import NotaFiscal
from app.modules.usuarios.models import User
from app.modules.vendas.models import (
    Sale,
    SaleItem,
    SalePayment,
    SaleReturn,
    SaleReturnItem,
    SaleReturnPayment,
    Voucher,
)

__all__ = [
    "AuditLog",
    "StoreConfig",
    "BackupConfig",
    "Base",
    "CashClosing",
    "CashClosingLine",
    "Category",
    "Customer",
    "CustomerPayment",
    "Expense",
    "ExpenseCategory",
    "LoginAttempt",
    "NotaFiscal",
    "Product",
    "ProductVariant",
    "RefreshToken",
    "Sale",
    "SaleItem",
    "SalePayment",
    "SaleReturn",
    "SaleReturnItem",
    "SaleReturnPayment",
    "StockBalance",
    "StockEntry",
    "StockMovement",
    "User",
    "Voucher",
]
