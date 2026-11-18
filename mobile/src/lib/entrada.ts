import { formatar, paraCentavos } from './money';

/**
 * Tira da conferência o que uma entrada já gravada levou.
 *
 * A resposta da Entrada se perde, a pessoa bipa mais peças e reenvia: o servidor recusa
 * com 409 (a chave é da entrada que existe) e devolve os itens dela. Trocar a chave e
 * reenviar a lista INTEIRA somaria de novo o que já entrou — 10 P gravadas + 7 M bipadas
 * depois virariam +20 P. Sai o que foi gravado; fica só o que falta registrar.
 *
 * Espelho de `web/js/entrada-gravada.js` — mudou aqui, mude lá.
 */
export interface ItemGravado {
  variante_id: number;
  quantidade: number;
}

export function tirarOQueJaEntrou<T extends { varianteId: number; quantidade: number }>(
  lista: T[],
  gravados: ItemGravado[],
): T[] {
  const restante = new Map<number, number>();
  for (const g of gravados) {
    restante.set(g.variante_id, (restante.get(g.variante_id) ?? 0) + g.quantidade);
  }
  const saida: T[] = [];
  for (const item of lista) {
    const jaEntrou = restante.get(item.varianteId) ?? 0;
    const tirar = Math.min(jaEntrou, item.quantidade);
    if (tirar > 0) restante.set(item.varianteId, jaEntrou - tirar);
    if (item.quantidade - tirar > 0) saida.push({ ...item, quantidade: item.quantidade - tirar });
  }
  return saida;
}

/** A nota que a entrada gravada já lançou, como o 409 a devolve (`detail.nota`). */
export interface NotaGravada {
  numero: string | null;
  valor_total: string;
  parcelas: { vencimento: string; valor: string }[];
}

/** "NF 4512", "nf-4512" e "NF4512" são o mesmo número; pontuação e caixa não contam. */
function chaveDoNumero(numero: string | null): string {
  return (numero ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/**
 * A nota do formulário é a que a entrada gravada já levou? Número dos dois lados decide
 * sozinho (mesmo número com outro valor é a mesma nota corrigida). Faltando número de um
 * lado, o mesmo valor diz que é a mesma; outro valor não dá para saber.
 */
function comparar(gravada: NotaGravada, doFormulario: NotaGravada): 'mesma' | 'outra' | 'talvez' {
  const a = chaveDoNumero(gravada.numero);
  const b = chaveDoNumero(doFormulario.numero);
  if (a && b) return a === b ? 'mesma' : 'outra';
  return paraCentavos(gravada.valor_total) === paraCentavos(doFormulario.valor_total) ? 'mesma' : 'talvez';
}

function resumo(nota: NotaGravada): string {
  const n = nota.parcelas.length;
  const qual = nota.numero ? `a nota ${nota.numero}` : 'a nota';
  return `${qual} (${formatar(paraCentavos(nota.valor_total))} em ${n} ${n === 1 ? 'parcela' : 'parcelas'})`;
}

const maiuscula = (frase: string) => frase.charAt(0).toUpperCase() + frase.slice(1);

const LANCE_A = 'lance-a em Contas a pagar, senão o boleto fica esquecido.';

/**
 * O que fazer com a nota do formulário depois do mesmo 409.
 *
 * As peças saem da lista; a nota também precisa sair quando a entrada gravada JÁ a levou —
 * ela está em Contas a pagar, e o reenvio do que falta com a mesma nota lançaria as
 * parcelas de novo (a nota de R$ 900 virava R$ 1.800). O servidor diz no `detail.nota`
 * qual nota a gravada levou, ou `null` se foi sem. Só sai a MESMA nota (`comparar`):
 * outra nota no formulário ainda não entrou, e tirá-la deixaria o boleto esquecido. E a
 * nota que fica só "vai com o que falta" se sobrou peça (`sobrouPeca`, a lista depois de
 * `tirarOQueJaEntrou`); lista vazia não registra nada, e a frase manda lançar a nota em
 * Contas a pagar. Sem a chave (servidor antigo), a tela não sabe: mantém e pede para conferir.
 *
 * Espelho de `notaDepoisDoDuplicado` em `web/js/entrada-gravada.js`.
 *
 * @param doFormulario a nota que foi no reenvio, no formato da API (`null` se foi sem)
 * @param sobrouPeca a conferência ainda tem peça a registrar depois de tirar a gravada
 */
export function notaDepoisDoDuplicado(
  detalhe: { nota?: NotaGravada | null } | null | undefined,
  doFormulario: NotaGravada | null,
  sobrouPeca: boolean,
): { tirarNota: boolean; frase: string } {
  const gravada = detalhe?.nota;
  if (!doFormulario) {
    if (!gravada) return { tirarNota: false, frase: '' };
    return { tirarNota: false, frase: `${maiuscula(resumo(gravada))} já está em Contas a pagar com a entrada gravada.` };
  }
  if (gravada === undefined) {
    return {
      tirarNota: false,
      frase: sobrouPeca
        ? 'Confira em Contas a pagar se esta nota já entrou antes de registrar o que falta.'
        : 'Confira em Contas a pagar se esta nota já entrou; se não entrou, lance-a lá.',
    };
  }
  if (gravada === null) {
    return {
      tirarNota: false,
      frase: sobrouPeca
        ? 'A entrada gravada foi sem nota: a nota do formulário fica e vai com o que falta.'
        : `A entrada gravada foi sem nota e não sobrou peça para levar a do formulário: ${LANCE_A}`,
    };
  }
  const levou = `A entrada gravada levou ${resumo(gravada)}, que já está em Contas a pagar.`;
  switch (comparar(gravada, doFormulario)) {
    case 'mesma':
      return {
        tirarNota: true,
        frase:
          `${maiuscula(resumo(gravada))} já está em Contas a pagar com a entrada gravada: tirei a nota do ` +
          'formulário para não lançá-la de novo. Se algo nela mudou, corrija em Contas a pagar.',
      };
    case 'outra': {
      const esta = `A nota ${doFormulario.numero} do formulário tem outro número`;
      return {
        tirarNota: false,
        frase: sobrouPeca
          ? `${levou} ${esta}: fica e vai com o que falta (se for a mesma nota, tire-a antes de registrar).`
          : `${levou} ${esta} e não sobrou peça para levá-la: ${LANCE_A}`,
      };
    }
    default: {
      const esta = `A do formulário é de ${formatar(paraCentavos(doFormulario.valor_total))}`;
      return {
        tirarNota: false,
        frase: sobrouPeca
          ? `${levou} ${esta} e ficou: se for a mesma nota, tire-a antes de registrar o que falta, senão ela entra duas vezes.`
          : `${levou} ${esta} e não sobrou peça para levá-la: se for outra nota, lance-a em Contas a pagar.`,
      };
    }
  }
}
