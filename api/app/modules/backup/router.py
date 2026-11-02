"""A porta do backup — só do dono (`GERIR_BACKUP`).

O token do Google NÃO tem rota de leitura, nem para o dono. Quem precisa dele é o
`backup.sh`, que o pega direto do banco na máquina. Uma rota que devolvesse a credencial
seria uma porta a mais para a mesma chave, sem nada em troca.
"""

from fastapi import APIRouter

from app.core.deps import ExigeBackup, SessionDep
from app.modules.backup.schemas import BackupOut, BackupUpdate
from app.modules.backup.service import BackupService

router = APIRouter(prefix="/backup", tags=["backup"])


@router.get("", response_model=BackupOut)
async def obter(session: SessionDep, _: ExigeBackup) -> BackupOut:
    return BackupOut.de_modelo(await BackupService(session).obter())


@router.put("", response_model=BackupOut)
async def atualizar(dados: BackupUpdate, session: SessionDep, usuario: ExigeBackup) -> BackupOut:
    """Trocar o token ou a pasta exige `senha_atual` (a de quem está salvando)."""
    return BackupOut.de_modelo(await BackupService(session).atualizar(dados, usuario))
