/**
 * Endereço da foto da peça, como a tela precisa dele (ADR-42, "Fotos no Vercel Blob").
 *
 * A API devolve `foto_url` de duas formas, conforme onde a foto mora:
 * - no disco da loja: caminho RELATIVO ("/media/produtos/x.jpg"), de propósito — montar a URL
 *   a partir do header Host deixaria um atacante gravar o próprio domínio no banco. Quem
 *   exibe completa com o servidor do APARELHO (`baseAtual()`);
 * - no Vercel Blob: URL ABSOLUTA ("https://<store>.public.blob.vercel-storage.com/..."), que
 *   já é o endereço da foto e passa como está.
 */
export function montarUrlDaFoto(caminho: string | null | undefined, base: string): string | null {
  if (!caminho) return null;
  if (/^https?:\/\//i.test(caminho)) return caminho;
  const raiz = base.replace(/\/+$/, '');
  return caminho.startsWith('/') ? `${raiz}${caminho}` : `${raiz}/${caminho}`;
}
