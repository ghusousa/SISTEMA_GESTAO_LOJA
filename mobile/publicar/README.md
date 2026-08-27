# Publicação automática na App Store

Publica a Fase 6 inteira sem clicar em nada: nome, subtítulo, descrição,
palavras-chave, as 10 capturas, categoria, classificação etária, preço grátis,
conta de demonstração, notas para o revisor, o build — e o envio para a revisão.

## Uma vez só (10 minutos)

1. Em [appstoreconnect.apple.com](https://appstoreconnect.apple.com):
   **Users and Access → Integrations → App Store Connect API → Team Keys → +**.
   Papel **App Manager**. Baixe o `.p8` (a Apple só deixa baixar uma vez).
2. Renomeie o arquivo para `chave-apple.p8` e ponha nesta pasta.
3. Copie `config.exemplo.json` para `config.json` e preencha (Key ID, Issuer ID,
   seus contatos e a conta de demonstração para o revisor).

`config.json` e `*.p8` estão no `.gitignore` desta pasta: **nunca** entram no git.

## Publicar (dentro de `mobile/`)

```bash
npx eas build --platform ios --profile production   # compila na nuvem
npm run publicar:build                              # sobe o build (cria o app na 1ª vez)
npm run publicar -- --enviar                        # ficha inteira + envia para revisão
```

Sem `--enviar`, o `npm run publicar` prepara tudo e para na beira — bom para
conferir no site antes. `npm run publicar:simular` só valida arquivos e textos,
sem falar com a Apple.

Os textos vêm de `ficha/` e as capturas de `media/app-store/iphone-6.5/` —
mudou lá, o próximo `npm run publicar` republica.

## O que continua manual (limite da Apple, sem API)

- A ficha **Privacidade do App** — uma vez, seguindo `docs/LOJAS-DE-APP.md` item 5.
- Criar a conta e aceitar os contratos.

## Teste

`node publicar/teste/rodar.mjs` sobe uma App Store Connect de mentira e roda a
publicação inteira contra ela, conferindo tudo o que chegou — inclusive os bytes
de cada captura.
