/**
 * Quando uma falha do `/auth/refresh` encerra a sessão.
 *
 * Só quando o SERVIDOR recusa o token (401/403): vencido, revogado, conta desativada. Queda
 * do Wi-Fi, timeout ou 5xx (a API reiniciando no `atualizar.sh`) não dizem nada sobre o
 * token — tratá-las como recusa apagava do cofre um refresh ainda válido e esvaziava o
 * carrinho do PDV, e a vendedora remontava a venda depois de entrar de novo. Nesses casos a
 * requisição falha como falha de rede (o BannerConexao já mostra a queda) e a sessão fica.
 *
 * `status` é o da resposta do refresh; sem resposta (rede caiu) ele não existe.
 */
export function refreshRecusado(status: number | undefined): boolean {
  return status === 401 || status === 403;
}
