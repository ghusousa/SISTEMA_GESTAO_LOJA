# Sistema de Gestão de Loja de Roupas

Estoque, PDV, despesas e resultado do mês — bipando o código de barras da peça, no celular ou no
computador do balcão.

- **`api/`** — FastAPI + PostgreSQL. É onde ficam as regras e a verdade dos dados.
- **`web/`** — sistema web completo, servido pela própria API. JavaScript puro, sem build.
- **`mobile/`** — app React Native (Expo) para Android e iOS.
- **`docs/`** — [SPEC.md](docs/SPEC.md) (o que o sistema faz) e [ARQUITETURA.md](docs/ARQUITETURA.md)
  (modelo de dados, contratos e as decisões, com o porquê de cada uma).

**As duas telas fazem o mesmo.** O app existe para andar pela loja com a câmera; o sistema web
existe para o balcão, com leitor USB e teclado — que é onde se digita preço, se lança despesa e se
fecha o caixa. Mesma API, mesmas regras, mesmos papéis.

## O que dá para fazer

| | |
|---|---|
| **Vender** | Bipar a etiqueta, montar o carrinho, dar desconto, receber em dinheiro/PIX/débito/crédito (podendo dividir entre formas) e confirmar. O estoque baixa na mesma transação. Venda comum sai em quatro toques. |
| **Cadastrar peças** | Produto com grade de tamanhos e cores. Cada peça tem seu código de barras: o EAN da etiqueta do fornecedor ou um código interno que o sistema gera — porque muita peça chega sem etiqueta. |
| **Controlar estoque** | Entrada por bipagem contínua, ajuste com motivo, inventário por contagem física e um extrato que explica cada saldo: quem mexeu, quando e por quê. |
| **Receber peça de volta** | A cliente chega com a blusa e sem nota: bipa a peça, o sistema mostra de quais vendas ela saiu, e o valor volta pelas mesmas formas em que entrou. Peça com defeito não volta para a arara. O que não puder voltar em dinheiro vira vale de troca — com código, para usar na próxima compra. |
| **Vender no fiado** | A caderneta dentro do sistema: quem levou, quanto deve, quem já acertou. O crediário abre em *quem está devendo*, que é a pergunta de segunda-feira. O limite combinado avisa, mas não bloqueia — quem conhece a freguesa é a dona. |
| **Dar o recibo** | O papel de sempre, com o que levou e como pagou. No balcão sai na impressora de bobina de 80 mm; no celular vai pelo WhatsApp. |
| **Controlar despesas** | Aluguel, energia, fornecedores. Contas fixas se repetem para o mês seguinte sem duplicar. |
| **Saber o resultado** | Faturamento, custo das peças vendidas, lucro bruto, despesas e o que sobrou. Mais vendidos, curva de vendas por dia e o que precisa repor. |
| **Fechar o caixa** | Conferir o esperado por forma de pagamento contra o contado. A diferença aparece — não é escondida. |
| **Trabalhar sem celular** | O sistema web faz tudo pelo computador: o leitor USB de balcão digita o código como se fosse teclado, e o PDV entende. `F2` cobra, `F4` desconta, `Esc` limpa. |
| **Vender pelo celular** | Cada vendedor entra com o próprio login no app e usa a câmera como leitor: bipa a etiqueta, vê o preço e fecha a venda andando pela loja. Um mesmo instalador serve para todos os aparelhos. |

**Tudo em tempo real.** Cadastrou uma peça no computador do balcão e ela aparece no celular da
vendedora na hora, sem fechar o app. Vendeu pelo celular e o saldo muda na tela do balcão. Vale
para catálogo, estoque, vendas, despesas e caixa.

**Quatro cargos**, cada um somando ao anterior:

| Cargo | Faz | Não alcança |
|---|---|---|
| **Vendedora** | Vende, bipa, consulta preço, cadastra peça, dá entrada | Custo, lucro, despesas, estorno, devolução, crediário, ajuste de estoque |
| **Supervisora** | Tudo acima, mais ajuste, inventário, editar catálogo, fechar o caixa e ver as vendas da equipe | Custo, lucro, despesas, estorno, devolução, crediário, logins |
| **Gerente** | Tudo acima, mais custo, lucro, despesas, relatórios, estorno, devolução, crediário e os logins da equipe | A conta do dono |
| **Dono** | Tudo | — |

Três regras que valem a pena saber: **quem vende não desfaz** (estorno é do dono e do gerente,
inclusive da venda própria), **quem confere o caixa não vê a margem** (a supervisora fecha o dia
sem saber o lucro) e **gerir logins não é virar dono** (o gerente não cria, promove nem edita um
dono). A filtragem acontece no servidor: o número que a pessoa não pode ver não sai da API, em vez
de ficar escondido na tela.

## Instalação

**Um comando.** O instalador pergunta o endereço, os dados do dono e a senha do banco, sobe tudo
em Docker e termina com o sistema **já rodando**.

### Pré-requisito: nenhum

O instalador cuida de tudo, inclusive de instalar o **Docker** se ele não estiver na máquina —
ele pergunta antes, e você responde Enter. Python, PostgreSQL e Node não são instalados: rodam
dentro dos containers e somem junto com eles.

| Sistema | O que o instalador faz |
|---|---|
| **Ubuntu / Linux** | Instala o Docker pelo script oficial (`get.docker.com`), liga o serviço e põe seu usuário no grupo `docker`. Precisa de `sudo`. |
| **Windows** | Instala o Docker Desktop pelo `winget`, abre e espera ficar pronto. O Windows pede permissão de administrador — aceite. |
| **Mac** | Instala o Docker Desktop pelo Homebrew, se você tiver o `brew`. |

Se preferir instalar o Docker por conta própria, use `--sem-docker` (Windows: `-SemDocker`) e o
instalador só verifica, sem mexer no sistema.

> **No Linux, uma observação.** Depois de instalar o Docker, seu usuário entra no grupo `docker`,
> mas isso só passa a valer no próximo login. Para a instalação não parar no meio, o instalador
> usa `sudo docker` pelo resto da execução e avisa. Saia e entre na sessão para dispensar o
> `sudo` no dia a dia.

### Instalar

**Ubuntu / Linux / Mac**

```bash
git clone https://github.com/ghusousa/SISTEMA_GESTAO_LOJA.git
cd SISTEMA_GESTAO_LOJA
./instalar.sh
```

**Windows**

Baixe o projeto — pelo [ZIP do GitHub](https://github.com/ghusousa/SISTEMA_GESTAO_LOJA/archive/refs/heads/main.zip)
(clique com o botão direito → *Extrair tudo*) ou com `git clone`. Depois, dentro da pasta:

**Clique duas vezes em `instalar.bat`.** Só isso — se faltar o Docker, ele instala.

Se preferir o terminal, abra o PowerShell na pasta e rode:

```powershell
.\instalar.bat
```

> **Por que `.bat` e não `.ps1`?** O Windows recusa scripts PowerShell não assinados e mostra
> *"não está assinado digitalmente"* (`PSSecurityException`) — e ainda bloqueia arquivos vindos de
> um ZIP baixado da internet. O `.bat` não passa por nenhuma das duas travas e chama o PowerShell
> do jeito certo. Para rodar o `.ps1` direto, é preciso destravar antes:
>
> ```powershell
> powershell -ExecutionPolicy Bypass -File .\instalar.ps1
> ```
>
> Se nem isso passar, a política veio de uma regra da empresa (GPO) e ignora o `Bypass`. Nesse
> caso peça a quem administra a máquina, ou rode o conteúdo por outro caminho:
>
> ```powershell
> Get-Content .\instalar.ps1 -Raw | powershell -NoProfile -Command -
> ```

### O que ele pergunta

```
1. Endereço do sistema
  Domínio (DNS) [localhost]: loja.minhaloja.com.br

2. Dono da loja
  Nome [Dona da Loja]: Dona Maria
  E-mail (é com ele que você entra): dona@minhaloja.com.br
  Senha do dono (mínimo 8 caracteres): ********
  repita a senha: ********

3. Banco de dados
  Gerar uma senha forte automaticamente? [S/n]: S

4. Fuso horário
  Fuso [America/Sao_Paulo]:

5. Avisos no celular (opcional)
  Sugestão de tópico: loja-k3x9q2mzt8wa
  Tópico do ntfy (vazio = os avisos ficam só no registro do servidor): loja-k3x9q2mzt8wa
```

| Pergunta | Para que serve |
|---|---|
| **Domínio (DNS)** | O endereço da loja. Com um domínio de verdade o **HTTPS é emitido e renovado sozinho**. `localhost` ou o IP da **rede da loja** (`192.168.…`, `10.…`, `172.16–31.…`) usam HTTP, sem HTTPS. **IP público é recusado** — veja abaixo. |
| **Nome / E-mail / Senha do dono** | A conta de administrador — a que vê custo, lucro, despesas e relatórios. É com esse e-mail que você entra. |
| **Senha do banco** | Fica só entre os containers; ninguém digita no dia a dia. Deixe gerar. |
| **Fuso horário** | Define o que é "hoje" no caixa e nos relatórios. |
| **Avisos no celular** | Opcional. Um tópico do [ntfy](https://ntfy.sh) (app gratuito, Android e iPhone): instale, toque em **+** e assine o mesmo nome. Loja fora do ar, disco enchendo, backup parado ou atualização que falhou chegam ali. Escolha um nome difícil de adivinhar — quem souber o nome lê os avisos. Fica no `.env` como `NOTIFICAR_URL`. |

No fim ele **liga a cópia diária do banco** (às 03:15; no Linux também o vigia de 5 em 5 minutos),
mostra **uma vez** a chave das cópias de fora (veja [Backup](#backup-automático-todo-dia)) e
imprime o endereço para abrir. **O sistema já está no ar** — não falta nenhum passo.

```
Pronto — o sistema está rodando

  Endereço:  https://loja.minhaloja.com.br/app/
  Modo:      domínio loja.minhaloja.com.br, com HTTPS automático
  Entrar:    dona@minhaloja.com.br
```

### Com domínio: HTTPS sem trabalho

Informando um domínio, o Caddy pede o certificado ao Let's Encrypt e o renova sozinho. Para isso
funcionar, duas coisas precisam estar prontas **antes** de rodar o instalador:

1. O **DNS do domínio aponta para o IP deste servidor** (registro `A`).
2. As **portas 80 e 443 estão abertas** — é por elas que o Let's Encrypt confere que o domínio é
   mesmo seu.

Acompanhe a emissão com `docker compose logs -f proxy`. Sem domínio, o instalador usa HTTP puro e
ajusta o resto sozinho — inclusive o cookie de sessão, que em HTTP não pode ser marcado `Secure`
(seria descartado pelo navegador e ninguém conseguiria continuar logado).

**Servidor na internet (VPS) sem domínio: o IP público é recusado.** HTTP puro só é aceitável
dentro da rede da loja; na internet, senha, token e CPF passariam em texto claro e a documentação
da API ficaria aberta. Sem domínio próprio, use o do [sslip.io](https://sslip.io), que é gratuito
e já aponta para o seu IP — o HTTPS sai sozinho do mesmo jeito:

```bash
./instalar.sh --dominio 203.0.113.10.sslip.io     # troque pelo IP do seu servidor
```

Num servidor que já foi instalado pelo IP, acrescente `--forcar` (os dados do banco ficam).

### Sem perguntas (automação)

```bash
./instalar.sh --dominio loja.minhaloja.com.br --nome "Dona Maria" \
    --email dona@minhaloja.com.br --senha "uma-senha-boa" --sim
```

```powershell
.\instalar.bat -Dominio loja.minhaloja.com.br -Nome "Dona Maria" `
    -Email dona@minhaloja.com.br -Senha "uma-senha-boa" -Sim
```

Outras opções: `--senha-banco`, `--fuso`, `--porta-http`, `--porta-https`, `--avisos TOPICO`
(o tópico do ntfy), `--forcar` (refaz o `.env` do zero) e `--sem-docker` (não instala o Docker
automaticamente). Rodar o instalador de novo é seguro: sem `--forcar`, ele reaproveita a
configuração e só religa o que estiver parado.

### O dia a dia

```bash
docker compose ps            # está no ar?
docker compose logs -f api   # o que está acontecendo
docker compose restart       # reiniciar
docker compose down          # desligar (os dados ficam guardados)
./instalar.sh                # religar
```

O sistema sobe sozinho quando a máquina liga: os containers têm `restart: unless-stopped`. No
Windows, isso depende do Docker Desktop estar marcado para iniciar com o sistema.

### Atualizar

Na pasta do sistema, um comando só:

```bash
./atualizar.sh
```

Ele guarda uma cópia do banco, baixa o código novo do GitHub, reconstrói, aplica as migrations e
confere se a loja voltou — mostrando cada passo. **Se a versão nova não subir, ele volta sozinho
para a anterior** e confirma que voltou. É para isso que existe, em vez de um `git pull` decorado:
quem atualiza às 8h50 de um sábado precisa que um erro se desfaça sozinho, e não de descobrir o
comando certo com fila no caixa.

Rodar sem novidade nenhuma é seguro: ele confere, avisa que já está na versão mais nova e sai sem
tocar em nada.

| Opção | Para quê |
|---|---|
| `--sim` | não pergunta nada (para deixar num agendamento) |
| `--sem-backup` | pula a cópia do banco, se você acabou de fazer uma |
| `--forcar` | atualiza descartando alterações feitas direto no servidor |
| `--ignorar-ci` | sobe mesmo sem o CI verde no GitHub (ver abaixo) |

**Só sobe versão aprovada pelo CI.** Antes de mexer em qualquer coisa ele pergunta ao GitHub
como está o CI do commit novo. Verde, segue. Vermelho, ainda rodando ou sem resposta: sozinho
(`--sim`) ele **não atualiza** — a loja fica na versão de antes e a tela diz que há uma nova
esperando; com alguém no terminal, ele pergunta. **E não insiste no que já caiu:** a versão que
subiu, não respondeu e foi desfeita fica anotada (`docker/estado/falhou`), e o timer só tenta de
novo quando chegar um commit **novo** — antes, um commit quebrado derrubava a loja a cada 10
minutos, o dia inteiro.

### Atualizar sozinho, sem comando nenhum

```bash
./atualizar.sh --automatico        # confere de 10 em 10 minutos
./atualizar.sh --automatico 30     # ou no intervalo que preferir
./atualizar.sh --sem-automatico    # desliga
```

A partir daí o servidor se atualiza sozinho: quando aparece versão nova, ele faz o backup,
reconstrói, migra e confere — e volta atrás sozinho se algo der errado, igual ao comando
manual. A loja fica fora do ar cerca de um minuto, só quando existe novidade de verdade.

Para ver o que aconteceu em cada conferida: `journalctl -u loja-atualizar -n 40`. O
`./diagnostico.sh` também diz se está ligada e se a última tentativa falhou.

**Repositório privado** — o servidor precisa de uma credencial gravada, senão o git para
pedindo senha e não há quem responda:

```bash
git remote set-url origin https://x-access-token:SEU_TOKEN@github.com/USUARIO/REPO.git
```

O token se cria em github.com/settings/tokens, com acesso de **leitura** ao repositório —
o servidor nunca precisa escrever. Para conferir o CI ele precisa ler também as verificações:
no token *fine-grained*, **Contents: leitura** e **Checks: leitura**; no clássico, `repo`. O
`--automatico` confere as duas coisas antes de agendar e avisa se faltar. Sem ler o CI, a
atualização sozinha não sobe nada e sai com erro — que vira aviso no celular (veja
[Avisos](#avisos-no-celular-e-o-vigia)).

**Windows** — se você clonou com git: `git pull` e depois `instalar.bat`. Se baixou o ZIP, baixe o
novo, extraia por cima **preservando o arquivo `.env`** (é ele que guarda as senhas desta
instalação) e rode `instalar.bat`. Os dados ficam nos volumes do Docker, não na pasta, então
trocar a pasta não perde venda nenhuma.

Depois de atualizar: no balcão, **Ctrl+F5** no navegador; no celular, feche e abra o app.

### Backup automático, todo dia

**Já nasce ligado.** O instalador liga a cópia diária às 03:15 — no Linux pelo systemd, no Mac
pelo launchd e no Windows por uma **Tarefa Agendada** ("Loja - copia diaria do banco", que roda o
`backup.ps1`). Com a máquina desligada nessa hora, a cópia sai assim que ela ligar. O
`./atualizar.sh` também faz uma cópia antes de mexer em qualquer coisa, mas isso protege contra o
que **você** faz — não contra o disco que morre às três da manhã. Para isso existe o `backup.sh`:

```bash
./backup.sh                       # agora, uma vez: dump validado + cópia fora
./backup.sh --automatico          # liga a cópia de todo dia às 03:15 (o instalador já ligou)
./backup.sh --automatico 23:40    # noutro horário
./backup.sh --listar              # o que existe, com data e tamanho
./backup.sh --mostrar-chave       # a chave que abre as cópias de fora
./backup.sh --restaurar backups/loja-2026-08-23-0315.dump
```

No Windows: `powershell -ExecutionPolicy Bypass -File backup.ps1` faz uma cópia na hora, em
`backups\`. Lá a cópia fica **só no computador**: leve a pasta `backups` para um pendrive ou para
a nuvem de vez em quando.

Três coisas que ele faz e que um `pg_dump` solto não faz:

1. **Confere o arquivo depois de gerar.** Dump que não abre é um arquivo, não um backup.
2. **Manda a cópia para fora do servidor**, quando você configura `BACKUP_REMOTO` no `.env`
   (qualquer destino do [rclone](https://rclone.org): Google Drive, S3, Backblaze…). Backup
   que mora só no servidor morre junto com ele.
3. **Tira um dump de segurança ANTES de restaurar.** Restaurar o arquivo errado é o jeito
   mais rápido de perder o que ainda estava certo.

Guarda 14 dias e apaga o resto sozinho. O `./diagnostico.sh` diz a idade do último backup —
backup velho é o tipo de coisa que só se descobre no dia em que ele é preciso. As cópias locais
são só do dono da pasta (`backups/` é 700, cada dump 600): elas são o banco inteiro, com CPF e
telefone das clientes.

#### As cópias de fora saem cifradas — guarde a chave

O que vai para o Google Drive (configurado na tela) e para o `BACKUP_REMOTO` sai **cifrado** pelo
`crypt` do rclone, com uma chave que nasce e mora **só neste servidor**
(`backups/.chave-do-backup`). No Drive, as cópias aparecem como `loja-AAAAMMDD-HHMMSS.dump.bin`:
o nome mostra a data, o conteúdo não abre sem a chave.

- **Guarde a chave fora do servidor** — no papel, num cofre de senhas, com o contador. O
  instalador a mostra uma vez; `./backup.sh --mostrar-chave` mostra de novo. Se o servidor
  morrer, a cópia do Drive **só abre com ela**, e ninguém consegue recuperá-la depois.
- **A cifra só liga depois que você confirma** que guardou a chave (`--mostrar-chave` pergunta;
  responda `SIM`). Até lá as cópias de fora saem como saíam antes, legíveis, e cada cópia
  repete o aviso — no terminal e, com `NOTIFICAR_URL`, no celular. É de propósito: numa loja
  que já existia, a chave nasce pelo timer sem ninguém olhando, e cifrar com ela trocaria
  "backup legível" por "backup que não abre" no dia em que o disco morrer.
- **Para restaurar** uma cópia baixada do Drive, inclusive numa máquina nova (instalada do zero):
  `./backup.sh --restaurar loja-20261101-031500.dump.bin` — ele pede a chave (maiúsculas, espaços
  e hífens não importam). Numa máquina sem chave, a que abriu passa a ser a dela.
- **As cópias de antes, em claro, continuam no Drive e legíveis.** O crypt não enxerga arquivos
  sem `.bin`, então a rotação não os apaga. Depois que houver algumas cópias `.dump.bin` novas,
  apague à mão as antigas que terminam só em `.dump` — elas têm o banco inteiro, sem proteção.

### Quando o sistema parar

Na pasta do sistema:

```bash
./diagnostico.sh
```

Ele **só lê** — não reinicia, não muda, não apaga nada; dá para rodar com a loja aberta. Confere
memória, disco, cada contêiner, se a API responde por dentro, se o banco responde, se a porta
responde de fora, e recorta do log só as linhas de erro. Termina dizendo o que tentar, na ordem, e
salva tudo num `diagnostico-<data>.txt` para mandar por WhatsApp.

Se você prefere ir direto ao ponto, a ordem que ele sugere é esta:

```bash
docker compose up -d       # religa o que caiu
docker compose restart     # reinicia tudo
./instalar.sh              # reconstrói e sobe — não apaga os dados
```

**Rode o diagnóstico ANTES de reiniciar.** Reiniciar com `up -d --build` troca o contêiner, e o
log do que caiu vai junto — depois disso não há mais como saber o motivo. (O `./atualizar.sh`
guarda o log sozinho antes de reconstruir, num `loja-backup-log-*.txt`.)

**A causa mais comum é a menos óbvia: disco cheio.** Perto de 100% o Postgres para de aceitar
escrita e a loja trava sem que nada de errado apareça no log da aplicação. `df -h /` mostra; o
diagnóstico avisa sozinho a partir de 90%.

### Avisos no celular e o vigia

Loja caída, disco enchendo, backup parado e atualização falhando só apareciam no registro da
máquina — quem descobria era a vendedora, com fila no caixa. Agora saem dela:

- **O vigia** (`./vigia.sh`, ligado pelo instalador no Linux) confere de 5 em 5 minutos se a API
  responde, se o disco passou de 90% e se o backup do Drive está atrasado (a última cópia com mais
  de 2× o intervalo da tela). Avisa quando o problema começa e quando passa. A API fora só avisa na
  segunda conferida seguida: uma atualização normal fica fora um ou dois minutos e não vira alarme.
- **Toda rotina que falha avisa**: a atualização sozinha, a cópia diária e a do Drive levam
  `OnFailure=` no systemd, que chama o `./notificar.sh`.
- **O aviso vai para o ntfy** do `NOTIFICAR_URL` no `.env` (o instalador pergunta; pode ser só o
  nome do tópico). Sem ele, fica em `journalctl -t loja-aviso`. O mesmo aviso não se repete antes
  de uma hora — e, enquanto o problema durar, o vigia lembra a cada 6 horas.

```bash
./notificar.sh --testar            # manda um aviso de teste agora
./vigia.sh                         # confere tudo agora e diz o que achou
./vigia.sh --automatico            # liga o vigia (o instalador já ligou)
./vigia.sh --sem-automatico        # desliga
```

Para pôr o tópico depois da instalação, acrescente `NOTIFICAR_URL=https://ntfy.sh/SEU-TOPICO` ao
`.env` e rode `./notificar.sh --testar`. O `./desinstalar.sh` desliga o vigia e as cópias junto,
para o celular não receber "loja fora do ar" de quem acabou de desligá-la.

### Dados de demonstração

Para ver o sistema cheio antes de cadastrar o seu, informando a conta de administrador que você
criou na instalação:

```bash
docker compose exec -e SEED_ADMIN_EMAIL=dona@minhaloja.com.br -e SEED_ADMIN_SENHA='sua-senha' \
    api python scripts/seed_demo.py
```

Cria 10 produtos com grade, ~100 vendas espalhadas por 25 dias, despesas e uma vendedora de teste
(`ana@loja.com` / `senha12345`). **Não rode no banco da loja de verdade** — é só para conhecer o
sistema, e a vendedora de teste tem senha pública.

### Usar de outro computador ou do celular

Todos na mesma rede: descubra o IP da máquina (`ip a` no Linux, `ipconfig` no Windows) e abra
`http://SEU_IP/app/`. No Windows, libere a porta uma vez, no PowerShell **como administrador**:

```powershell
New-NetFirewallRule -DisplayName "Sistema da Loja" -Direction Inbound `
    -LocalPort 80 -Protocol TCP -Action Allow -Profile Private
```

> `-Profile Private` de propósito: libera na rede da loja, não em Wi-Fi público.

Para o **app do celular**, é esse mesmo endereço que o vendedor informa na primeira abertura —
o app pergunta e guarda no aparelho.

### App do celular — cada vendedor com o seu

O celular vira o leitor: o vendedor aponta a câmera para a etiqueta, vê o preço e fecha a venda.
Cada um entra com o próprio login de VENDEDOR, e o que ele não pode ver — custo, lucro, despesas,
relatórios — continua barrado no servidor, não escondido na tela.

**Um instalador serve para todos os celulares.** O endereço do servidor é perguntado na primeira
abertura e guardado no aparelho, em vez de ficar preso ao build. Se a loja trocar de IP, ninguém
reinstala nada: é só "Mais → Conectado em…" e informar o novo endereço.

O passo a passo para gerar o `.apk` (na nuvem da Expo, sem instalar Android Studio) e colocá-lo
nos celulares está em
[docs/DEPLOY.md](docs/DEPLOY.md#parte-2--app-no-celular-dos-vendedores).

**Para testar no seu celular agora, sem gerar instalador**, veja
[Rodar o app no celular](#rodar-o-app-no-celular) mais abaixo. Para gerar o `.apk` e distribuir
para a equipe, o passo a passo está em
[docs/DEPLOY.md](docs/DEPLOY.md#parte-2--app-no-celular-dos-vendedores).

### Rede que inspeciona HTTPS

Em algumas empresas o build quebra com `certificate verify failed`. Não é erro do projeto: o `pip`
dentro do container não conhece o certificado que a rede usa. Coloque-o em
`docker/certificados/` e rode `./instalar.sh --forcar`. Detalhes em
[docker/certificados/LEIA-ME.md](docker/certificados/LEIA-ME.md).

### Desenvolvimento sem Docker

Para mexer no código com recarga automática, dá para rodar a API direto na máquina — precisa de
Python 3.11+ e um PostgreSQL 16. O `api/docker-compose.yml` sobe só o banco de desenvolvimento,
já com o usuário e a senha que o `api/.env.example` espera:

```bash
cd api
docker compose up -d                       # só o Postgres, na porta 5432
python3 -m venv .venv && .venv/bin/pip install -r requirements.lock -r requirements-dev.lock
.venv/bin/pip install -e . --no-deps       # as versões da trava, as mesmas do CI e da imagem
cp .env.example .env                       # ajuste DATABASE_URL e JWT_SECRET
.venv/bin/alembic upgrade head
.venv/bin/python -m app.cli create-admin --nome "Dona" --email d@l.com --senha "senha1234"
.venv/bin/uvicorn app.main:app --reload
```

O sistema web fica em <http://localhost:8000/app/> e a documentação da API em `/docs`.
O app do celular: `cd mobile && npm install && npm start`.

## Rodar o app no celular

Dá para abrir o app no seu celular em poucos minutos, **sem compilar nada**, usando o **Expo Go**.
É assim que se testa antes de gerar o instalador para a equipe.

### 1. Node.js no computador

O Expo roda sobre o Node. É o único programa a mais que você precisa — o Docker não serve para
isto.

| Sistema | Comando |
|---|---|
| **Windows** | `winget install -e --id OpenJS.NodeJS.LTS` |
| **Ubuntu / Linux** | `sudo apt install -y nodejs npm` |
| **Mac** | `brew install node` |

Ou baixe a versão **LTS** em <https://nodejs.org>.

> **No Windows, depois de instalar, feche o terminal e abra outro.** A janela que já estava
> aberta não enxerga o que acabou de entrar no PATH — e o erro seguinte seria "node não é
> reconhecido", que não explica isso.

Confira com `node -v`. Precisa ser **20.19.4 ou mais novo** — um 20.18 instalado há um ano
não serve, e o erro que ele dá (`Node.js is outdated and unsupported`) aparece só lá na
frente, depois de baixar tudo.

### 2. Subir o app

**Windows** (PowerShell, na pasta do projeto):

```powershell
cd mobile
.\testar.bat
```

**Linux / Mac**:

```bash
cd mobile
./testar.sh
```

Na primeira vez ele instala as dependências — demora alguns minutos e não pede nada. Depois sobe
o servidor de desenvolvimento e o terminal fica assim:

```
› Metro waiting on exp://192.168.0.15:8081
› Scan the QR code above with Expo Go (Android) or the Camera app (iOS)

  ▄▄▄▄▄▄▄  ▄▀ ▀▄▄  ▄▄▄▄▄▄▄
  █ ▄▄▄ █ ▀█▄ ▄▀█  █ ▄▄▄ █      (o QR de verdade aparece aqui)
  █ ███ █ █▀▄▀ ▄▀  █ ███ █
  ▀▀▀▀▀▀▀ ▀ ▀ ▀ ▀  ▀▀▀▀▀▀▀

› Press a │ open Android    › Press r │ reload app
› Press w │ open web        › Press ? │ show all commands
```

**Deixe essa janela aberta** — é ela que serve o app. Fechar derruba o celular.

### 3. No celular

1. Instale o **Expo Go** (Play Store ou App Store).
2. Deixe o celular na **mesma rede Wi-Fi** do computador.
3. **Android:** abra o Expo Go e toque em *Scan QR code*.
   **iPhone:** abra a câmera normal e aponte para o QR.
4. O app abre no login. Se ele ainda não souber o endereço do servidor, o rodapé avisa: toque
   na **engrenagem** no canto superior direito e informe o mesmo endereço que você digita no
   navegador do balcão. Pode colar o endereço inteiro; o app aproveita só a parte que interessa.
5. Entre com um login de **vendedor**, criado em *Usuários* no sistema web.

### Teclas úteis enquanto roda

Com a janela do terminal em foco:

| Tecla | O que faz |
|---|---|
| `r` | recarrega o app no celular |
| `a` | abre num emulador Android conectado |
| `w` | abre no navegador do computador (útil para ver rápido) |
| `j` | abre o depurador |
| `?` | lista todos os comandos |
| `Ctrl+C` | encerra |

### Quando o QR não carrega

Quase sempre é rede, não o app.

**Firewall do Windows** bloqueando a porta 8081. No PowerShell **como administrador**, uma vez:

```powershell
New-NetFirewallRule -DisplayName "Expo" -Direction Inbound `
    -LocalPort 8081 -Protocol TCP -Action Allow -Profile Private
```

**Wi-Fi que isola os aparelhos** (comum em prédio, hotel e rede de visitante): use o túnel, que
funciona em qualquer rede, só mais devagar.

```powershell
.\testar.bat --tunel
```
```bash
./testar.sh --tunel
```

**"Project is incompatible with this version of Expo Go"** — não deveria mais acontecer, mas se
acontecer é desalinhamento de SDK. Este projeto está no **SDK 54** de propósito: **54 é a última
versão do Expo Go publicada na App Store e na Play Store**. A Expo parou de publicar o Expo Go
para SDK 55 e mais recentes, então "atualizar o Expo Go" não resolve nada — já está no topo.
Se você atualizar o projeto para um SDK acima do 54, o teste por QR deixa de existir e o único
caminho passa a ser gerar um *development build*.

**Node.js desatualizado.** O Expo avisa `Node.js (vX) is outdated and unsupported`. É preciso
**Node 20.19.4 ou mais novo**. No Windows: `winget upgrade OpenJS.NodeJS.LTS` (e feche o terminal
antes de tentar de novo). Confira com `node -v`.

**Ele pede login da Expo.** Não precisa de conta: escolha **"Proceed anonymously"** com as setas e
Enter. Se você escolher *Log in* e apertar Enter num campo vazio, o Expo quebra com
`AssertionError` — nesse caso é só encerrar com `Ctrl+C` e subir de novo.

**Bundle travado ou comportamento estranho** depois de mexer em dependências: limpe o cache com
`npx expo start -c`.

> **Duas conexões diferentes, e é aqui que a maioria se perde.** O celular precisa alcançar o
> **computador que roda o Expo** — por isso a mesma Wi-Fi — e também o **servidor da loja**, que
> pode estar em qualquer lugar, inclusive numa VPS pública, e funciona até no 4G. Quando o `.apk`
> estiver pronto, só a segunda continua valendo: o vendedor usa de onde quiser.

### Outros comandos do app

Todos dentro de `mobile/`:

```bash
npm start                  # o mesmo que testar.sh, sem as explicações
npm run android            # abre direto num emulador/aparelho Android conectado
npm run web                # abre no navegador do computador
npm run typecheck          # confere os tipos (tsc --noEmit)
npm test                   # testes da camada de dinheiro
npm run bundle             # empacota; pega erro de import que o typecheck não vê
```

## Desinstalar

```bash
./desinstalar.sh          # Linux/Mac
```
```powershell
.\desinstalar.bat         # Windows (ou clique duas vezes)
```

**Ele faz backup do banco antes de apagar qualquer coisa** e só continua depois que você digitar
`APAGAR`. O arquivo `.dump` fica na pasta do projeto — guarde fora da máquina.

| Opção | O que muda |
|---|---|
| *(nenhuma)* | Backup, confirmação, e apaga tudo: containers, banco, fotos e `.env` |
| `--manter-dados` | Só desliga e remove os containers. Os dados ficam; `./instalar.sh` traz tudo de volta |
| `--sem-backup` | Pula o backup (use com consciência) |
| `--apagar-imagens` | Remove também a imagem construída |
| `--sim` | Não pergunta nada (automação) |

No Windows são as mesmas, com traço único: `-ManterDados`, `-SemBackup`, `-ApagarImagens`, `-Sim`.

### Restaurar um backup

O caminho normal é `./backup.sh --restaurar ARQUIVO` (ver **Backup automático, todo dia**) —
é o único que abre a cópia **cifrada** do Drive (`.dump.bin`): ele pede a chave guardada fora do
servidor. Na mão, para um dump antigo (em claro). O schema é zerado antes: `pg_restore --clean` só derruba o que
está no dump, e uma tabela criada por migration mais nova ficaria para trás — a API não
subiria mais (`DuplicateTable` no `alembic upgrade head`).

```bash
./instalar.sh
docker compose stop api
docker compose exec -T db psql -U loja -d loja -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION pg_database_owner; GRANT USAGE ON SCHEMA public TO PUBLIC;"
docker compose exec -T db pg_restore -U loja -d loja --no-owner < loja-backup-2026-08-22-1438.dump
docker compose start api
```

```powershell
.\instalar.bat
docker compose stop api
docker compose exec -T db psql -U loja -d loja -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION pg_database_owner; GRANT USAGE ON SCHEMA public TO PUBLIC;"
cmd /c "docker compose exec -T db pg_restore -U loja -d loja --no-owner < loja-backup-2026-08-22-1438.dump"
docker compose start api
```

### Tirar o Docker também

Só se ele entrou na máquina por causa deste projeto:

```bash
sudo apt purge -y docker-ce docker-ce-cli containerd.io && sudo apt autoremove -y
```

No Windows: **Configurações → Aplicativos → Aplicativos instalados → Docker Desktop**.

### Só o app do celular

Desinstale pelo próprio aparelho. Os dados ficam todos no servidor, então tirar o app de um
celular não apaga venda nenhuma.

## Testes

```bash
cd api    && .venv/bin/pytest -q            # 106 testes contra Postgres real
cd mobile && npm run typecheck && npm test  # TypeScript + camada de dinheiro
```

Os testes da API rodam contra um Postgres de verdade (`loja_test`), não SQLite: é o que exercita
`CHECK`, índice único parcial, coluna gerada e as corridas de concorrência que só aparecem com o
banco real.

Com a API no ar, o cenário completo de um dia de loja — do cadastro ao fechamento do caixa,
passando por venda com pagamento misto, cancelamento e conferência do resultado — roda com:

```bash
cd api && .venv/bin/python scripts/e2e.py
```

**O CI** (`.github/workflows/ci.yml`) roda uma vez por commit — push no `main` e pull request —
e cobre: pytest com as migrations subindo e descendo; a API no ar com o `e2e.py` e o
`pentest.py` (reprova com qualquer achado); `npm test`, `tsc` e o bundle do app; a imagem
Docker construída do jeito que a loja constrói; e `shellcheck` nos scripts de operação. É
desse resultado que o `./atualizar.sh` das lojas depende para subir uma versão.

As dependências Python têm **versão exata** em `api/requirements.lock` (o que a imagem e o CI
instalam) e `api/requirements-dev.lock` (só os testes). Subir uma biblioteca é mudar a trava,
rodar a suíte e deixar o CI confirmar — nunca mais "a versão do dia do build".

## Deploy

O guia de produção (VPS Ubuntu com systemd, Nginx, SSL, backup e atualização) está em
[docs/DEPLOY.md](docs/DEPLOY.md). Publicação do app nas lojas via EAS Build está no mesmo arquivo.

## Notas que economizam tempo

- **Dinheiro** é `Decimal`/`NUMERIC(14,2)` no servidor, string decimal (`"149.90"`) no fio e
  inteiro de centavos no app. Nunca `float`: `0.1 + 0.2` no caixa é dinheiro errado.
- **O dia do comércio** é o do fuso da loja (`TIMEZONE_LOJA`, padrão `America/Sao_Paulo`), não o do
  servidor. Às 23h de São Paulo o UTC já virou; consultar o caixa pelo dia UTC devolveria vazio.
- **Saldo de estoque** só muda junto com uma movimentação, na mesma transação, e nunca fica
  negativo. Se um número parecer errado, o extrato tem a resposta.
- **Venda e entrada são idempotentes** por `client_uuid`: reenviar depois de um timeout não
  duplica nada. Vale para o app e para qualquer integração futura.
- **Leitor USB é teclado.** O leitor de balcão não tem driver nem API: ele digita os dígitos em
  rajada e aperta Enter. O PDV web ouve o teclado inteiro, então funciona mesmo com o foco perdido
  em um botão — e o mesmo campo aceita o código digitado à mão quando a etiqueta está rasgada.
- **Campo de dinheiro que já vem preenchido é sugestão.** O primeiro dígito depois de focar
  recomeça o número; do segundo em diante, empurra pela direita (estilo caixa registradora).
  Sem isso, digitar `200` sobre um campo mostrando `179,70` daria R$ 17.970,00.
- **No navegador o refresh token fica em cookie `httpOnly`**, nunca em `localStorage`: o access
  token vive só na memória da página e a sessão volta sozinha ao recarregar.
