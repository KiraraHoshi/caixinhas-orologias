# Orolon Caixinhas no Android

O app Android é o mesmo site (`index.html`), empacotado com o [Capacitor](https://capacitorjs.com). Tudo é montado no GitHub Actions; nada precisa ser instalado no PC.

## APK de teste (automático)

Cada envio, de qualquer branch, gera um APK de teste publicado em **Releases → Android (teste)**. A página diz de qual branch ele veio.
Ele é assinado com a chave fixa de `android-teste/`, então cada versão nova instala por cima da anterior.

Identificador do app: `com.joah.caixinhas` (não muda depois de publicado na Google Play).

**APK de teste ao lado do app da loja (desde a 2.0):** o APK de teste tem o identificador `com.joah.caixinhas.teste` e se chama "Orolon Caixinhas (teste)", então os dois ficam instalados juntos, cada um com os seus dados, a sua pasta de backup e o seu widget. Quem decide é `scripts/plugin-android.mjs`: sem `CX_LOJA=1` ele põe `applicationIdSuffix ".teste"` no `build.gradle` e o "(teste)" no nome; com `CX_LOJA=1` (pacote da loja) não mexe em nada disso. O que depende do identificador acompanha sozinho (o FileProvider usa `${applicationId}` no manifesto e `getPackageName()` no plugin).
Os dados de um APK de teste anterior à 2.0 (`com.joah.caixinhas`) **não passam sozinhos** para o novo: exporte um backup no antigo e importe no novo.

As versões das bibliotecas ficam presas no `package-lock.json` (o workflow usa `npm ci`). Para atualizar o Capacitor: `npm install` no PC e commitar o `package-lock.json` novo.

O arquivo da loja (`.aab`) e a chave de envio ainda não existem; entram quando o app for para a Play.

## O que muda dentro do app

O `index.html` percebe que está no app (`window.Capacitor`) e só então:

- bloqueia o zoom de pinça;
- faz o botão voltar fechar uma coisa por vez (folha de lançar, parte dos Ajustes, aba) e sair do app no Início;
- troca "baixar arquivo" pelo compartilhamento do Android (backup, planilha, tema);
- grava o backup automático numa pasta escolhida no seletor do Android;
- oferece lembretes de contas a vencer por notificação;
- manda a sobra do mês ao widget "Lançar gasto" a cada salvamento e abre a folha de lançar quando o app vem pelo toque nele;
- esconde o apoio pelo GitHub (links "Apoie o projeto" e a tela Apoie), que continua só no site.

## Barras do sistema

O app desenha de ponta a ponta em todo Android (`EdgeToEdge.enable(this)` na `MainActivity`, posto pelo `scripts/plugin-android.mjs`) e o recuo das barras de status e de navegação é feito pelo próprio Android (`SystemBars.insetsHandling: "native"` no `capacitor.config.json`). É o mesmo conserto do Orolon Player 1.26.5: com o recuo pelo CSS, em WebView antigo ele era somado duas vezes. As variáveis `--topo`/`--base` do `index.html` continuam: em WebView novo (com `viewport-fit=cover`) o Capacitor repassa o recuo à página e elas o aplicam; em WebView antigo o próprio Android recua a tela e elas valem zero, sem somar duas vezes (conferido em `SystemBars.java` do Capacitor 8).

O service worker não entra no app: os arquivos já vêm dentro dele.

## Permissões

- **Notificações** (`POST_NOTIFICATIONS`): pedida à pessoa só quando ela liga o lembrete em Ajustes › Lembretes.
- As que o plugin de notificações traz para reagendar os lembretes depois que o celular reinicia (`RECEIVE_BOOT_COMPLETED`, `WAKE_LOCK`). Não aparecem como pergunta.
- **Internet: não.** `scripts/plugin-android.mjs` tira a permissão que o Capacitor põe por padrão, e o workflow falha se ela aparecer no manifesto final.
- Armazenamento: não. A pasta do backup é liberada pelo seletor de pastas do Android, só ela.
- O widget não pede nenhuma.

O workflow lista no resumo de cada envio as permissões e o identificador do APK que saiu (e falha se o APK de teste não terminar em `.teste`).

## Plugin próprio

`android-plugin/CaixinhasPlugin.java` (ligado pelo `scripts/plugin-android.mjs`):

- **compartilhar:** grava o arquivo na pasta temporária do app e abre o compartilhamento. Quem envia é o app escolhido pela pessoa.
- **pasta do backup:** uma cópia por dia, `caixinhas-backup-AAAA-MM-DD-xxxx.json`, em que `xxxx` é a marca do aparelho. Ficam as 7 mais novas **daquele aparelho**; cópias de outro aparelho nunca são apagadas nem trocadas. Numa pasta que já tem cópias, o app mostra quais são e pergunta antes de gravar.

## Lembretes

Plugin oficial `@capacitor/local-notifications`. O app agenda no próprio aparelho uma notificação por dia de vencimento (faturas e gastos fixos dos próximos 60 dias), sem valores no texto, e refaz a agenda quando abre ou quando as contas mudam. A hora é aproximada (o app não pede a permissão de alarme exato).

O ícone da notificação é o símbolo do app em uma cor só (`android-assets/res/drawable/ic_notif.xml`, desenho vetorial branco sobre transparente, sem tamanhos separados), ligado por `LocalNotifications.smallIcon: "ic_notif"`; a cor vem de `iconColor`.

## Widget "Lançar gasto"

`android-plugin/LancarWidget.java`, com layout, fundo, textos e dados em `android-assets/res/` (o `scripts/plugin-android.mjs` copia para `res/` e registra o `<receiver>` no manifesto, como na documentação do Android: `exported="false"`, quem manda as atualizações é o próprio sistema).

- Mostra o botão "+ Lançar gasto" e, embaixo, a sobra do mês e quanto dá por dia. Começa 2x2 e pode encolher até 2x1 (aí sai a linha do "por dia"). Cores do tema padrão.
- A cada salvamento o app chama `Caixinhas.widget({ sobra, mes, ultimoDia, mostrar })` (texto com ponto, "AAAA-MM", número, sim/não), que fica guardado no aparelho e redesenha o widget.
- O "por dia" (sobra ÷ dias que faltam, contando hoje) é refeito pelo próprio widget; o Android o atualiza uma vez por dia sem o app aberto. Se o mês virou, ele mostra só o botão até o app ser aberto.
- **Com PIN ligado** o app manda `mostrar: false` e a sobra vazia: nenhum valor fica guardado fora do app e o widget mostra só o botão.
- Tocar abre o app com o endereço `caixinhas://lancar`. O app abre a folha de lançar (com o PIN, só depois do código). O endereço vale uma vez: reabrir o app pelos recentes ou pelo ícone não abre a folha de novo (a `MainActivity` tira o endereço quando o Android recria a tela, e o `index.html` ignora o endereço de abertura num recarregar).

## Ícone e tela de abertura

`node scripts/gerar-icones.mjs` gera as imagens de `android-assets/` a partir de `icon-simbolo.svg`. As peças de `android-assets/res/` (widget e ícone da notificação) são escritas à mão.
