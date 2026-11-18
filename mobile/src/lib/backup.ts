/**
 * O que a tela diz sobre o backup na nuvem. **Espelho de `situacao()` em
 * `web/js/views/backup.js` — mudou um, mude o outro.**
 *
 * O atraso não é calculado aqui: o servidor manda `atrasado` pronto (ligado e sem cópia
 * nova há mais de 2× o intervalo), para web, app e selo não divergirem. Olhar só
 * `ultimo_ok` dizia "Funcionando" com a cópia parada havia dias.
 */

import type { Backup } from '@/api/tipos';

/** A tela do backup e o selo da aba Mais leem a mesma consulta. */
export const CHAVE_BACKUP = ['backup'] as const;

export type TomDoBackup = 'ok' | 'info' | 'alerta' | 'perigo';

export interface SituacaoDoBackup {
  texto: string;
  tom: TomDoBackup;
}

type Estado = Pick<Backup, 'configurado' | 'ativo' | 'ultimo_ok' | 'ultimo_em' | 'atrasado'>;

export function situacaoDoBackup(b: Estado): SituacaoDoBackup {
  if (!b.configurado) return { texto: 'Conta do Google não conectada', tom: 'alerta' };
  if (!b.ativo) return { texto: 'Desligado', tom: 'info' };
  if (b.ultimo_ok === false) return { texto: 'A última cópia FALHOU', tom: 'perigo' };
  if (b.atrasado) {
    return { texto: b.ultimo_em ? 'Atrasado' : 'Atrasado: nenhuma cópia ainda', tom: 'alerta' };
  }
  if (b.ultimo_ok === true) return { texto: 'Funcionando', tom: 'ok' };
  return { texto: 'Ligado, primeira cópia ainda não rodou', tom: 'info' };
}

/** O selo da aba Mais só aparece quando há problema: backup em dia não ocupa a tela. */
export function backupPrecisaDeAtencao(b: Estado): boolean {
  return b.ativo && (b.atrasado || b.ultimo_ok === false);
}

/** Trocar a conta ou a pasta de um backup já conectado pede a senha de novo (ADR-28). */
export function trocaPedeSenha(
  b: Pick<Backup, 'configurado' | 'pasta'>,
  novo: { token: string; pasta: string },
): boolean {
  return b.configurado && (novo.token.trim() !== '' || novo.pasta.trim() !== b.pasta);
}
