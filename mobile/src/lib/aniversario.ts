/**
 * Data de nascimento no balcão: digitada como a gente fala ("14/03/1990"), guardada como a
 * API entende ("1990-03-14"). Sem `new Date(texto)`: o fuso do aparelho comeria um dia —
 * "1990-03-14" lido como UTC vira 13/03 às 21h em São Paulo (ADR-27).
 */

/** "14/03/1990" (ou "14031990") → "1990-03-14". `null` se não for uma data possível. */
export function paraDataISO(texto: string, hoje: Date = new Date()): string | null {
  const digitos = texto.replace(/\D/g, '');
  if (digitos.length !== 8) return null;
  const dia = Number(digitos.slice(0, 2));
  const mes = Number(digitos.slice(2, 4));
  const ano = Number(digitos.slice(4, 8));
  if (ano < 1900 || mes < 1 || mes > 12 || dia < 1) return null;
  // Dia 0 do mês seguinte é o último dia deste — e já resolve fevereiro bissexto.
  const ultimoDia = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  if (dia > ultimoDia) return null;
  const iso = `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
  // Nascer no futuro é erro de digitação. A comparação é de texto ISO, sem fuso.
  const hojeIso = [
    hoje.getFullYear(),
    String(hoje.getMonth() + 1).padStart(2, '0'),
    String(hoje.getDate()).padStart(2, '0'),
  ].join('-');
  return iso > hojeIso ? null : iso;
}

/** "1990-03-14" → "14/03/1990". */
export function dataBR(iso: string | null | undefined): string {
  if (!iso) return '';
  const [ano, mes, dia] = iso.slice(0, 10).split('-');
  return ano && mes && dia ? `${dia}/${mes}/${ano}` : iso;
}

/** Máscara enquanto digita: "1403" → "14/03", "14031990" → "14/03/1990". */
export function mascararData(texto: string): string {
  const d = texto.replace(/\D/g, '').slice(0, 8);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}/${d.slice(2)}`;
  return `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`;
}
