"""Código de barras interno para peças que chegam sem etiqueta do fornecedor.

Geramos um EAN-13 válido no prefixo 2 — a faixa que o padrão GS1 reserva para uso interno
da loja, justamente para não colidir com nenhum produto do mundo. Sendo um EAN-13 de verdade,
qualquer leitor (e a câmera do app) lê sem configuração especial.
"""

PREFIXO_INTERNO = "2"
TAMANHO_PAYLOAD = 12  # 12 dígitos + 1 verificador


def digito_verificador_ean13(payload: str) -> str:
    """Dígito verificador do EAN-13: pesos 1 e 3 alternados, complemento de 10."""
    if len(payload) != TAMANHO_PAYLOAD or not payload.isdigit():
        raise ValueError("O payload do EAN-13 precisa ter exatamente 12 dígitos.")
    soma = sum(int(d) * (1 if i % 2 == 0 else 3) for i, d in enumerate(payload))
    return str((10 - soma % 10) % 10)


def montar_codigo_interno(sequencia: int) -> str:
    """Transforma o próximo valor da sequência do banco em um EAN-13 interno."""
    corpo = str(sequencia).rjust(TAMANHO_PAYLOAD - len(PREFIXO_INTERNO), "0")
    payload = f"{PREFIXO_INTERNO}{corpo}"
    if len(payload) != TAMANHO_PAYLOAD:
        raise ValueError("A sequência de códigos internos estourou o formato EAN-13.")
    return payload + digito_verificador_ean13(payload)


def ean13_valido(codigo: str) -> bool:
    if len(codigo) != TAMANHO_PAYLOAD + 1 or not codigo.isdigit():
        return False
    return digito_verificador_ean13(codigo[:TAMANHO_PAYLOAD]) == codigo[-1]


def eh_codigo_interno(codigo: str | None) -> bool:
    """Diz se um código de barras foi gerado por esta loja.

    O prefixo 2 é a faixa que o GS1 reserva para uso interno: nenhum produto do mundo
    circula com ele, então quem começa com 2 e fecha o verificador saiu daqui.

    Existe porque o cliente devolve o código no formulário. Quem pede um código interno
    pela tela recebe o número, ele preenche o campo, e o cadastro chega ao servidor com
    `codigo_barras` preenchido — indistinguível de uma etiqueta digitada do fornecedor.
    A peça acabava rotulada "etiqueta do fornecedor" na tela do produto, o oposto do que
    era. Olhar o número resolve sem depender de o cliente avisar de onde ele veio.
    """
    return bool(codigo) and ean13_valido(codigo) and codigo.startswith(PREFIXO_INTERNO)
