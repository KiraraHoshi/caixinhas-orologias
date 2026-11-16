# Orolon Caixinhas no Android

O app Android é o mesmo site (`index.html`), empacotado com o [Capacitor](https://capacitorjs.com). Tudo é montado no GitHub Actions; nada precisa ser instalado no PC.

## APK de teste (automático)

Cada envio, de qualquer branch, gera um APK de teste publicado em **Releases → Android (teste)**. A página diz de qual branch ele veio.
Ele é assinado com a chave fixa de `android-teste/`, então cada versão nova instala por cima da anterior.

Identificador do app: `com.joah.caixinhas` (não muda depois de publicado na Google Play).

O arquivo da loja (`.aab`) e a chave de envio ainda não existem; entram quando o app for para a Play.

## O que muda dentro do app

O `index.html` percebe que está no app (`window.Capacitor`) e só então:

- bloqueia o zoom de pinça e respeita a barra de status e a de navegação;
- faz o botão voltar fechar uma coisa por vez (folha de lançar, parte dos Ajustes, aba) e sair do app no Início;
- troca "baixar arquivo" pelo compartilhamento do Android (backup, planilha, tema);
- grava o backup automático numa pasta escolhida no seletor do Android;
- oferece lembretes de contas a vencer por notificação.

O service worker não entra no app: os arquivos já vêm dentro dele.

## Permissões

- **Notificações** (`POST_NOTIFICATIONS`): pedida à pessoa só quando ela liga o lembrete em Ajustes › Lembretes.
- As que o plugin de notificações traz para reagendar os lembretes depois que o celular reinicia (`RECEIVE_BOOT_COMPLETED`, `WAKE_LOCK`). Não aparecem como pergunta.
- **Internet: não.** `scripts/plugin-android.mjs` tira a permissão que o Capacitor põe por padrão, e o workflow falha se ela aparecer no manifesto final.
- Armazenamento: não. A pasta do backup é liberada pelo seletor de pastas do Android, só ela.

## Plugin próprio

`android-plugin/CaixinhasPlugin.java` (ligado pelo `scripts/plugin-android.mjs`):

- **compartilhar:** grava o arquivo na pasta temporária do app e abre o compartilhamento. Quem envia é o app escolhido pela pessoa.
- **pasta do backup:** uma cópia por dia, `caixinhas-backup-AAAA-MM-DD-xxxx.json`, em que `xxxx` é a marca do aparelho. Ficam as 7 mais novas **daquele aparelho**; cópias de outro aparelho nunca são apagadas nem trocadas. Numa pasta que já tem cópias, o app mostra quais são e pergunta antes de gravar.

## Lembretes

Plugin oficial `@capacitor/local-notifications`. O app agenda no próprio aparelho uma notificação por dia de vencimento (faturas e gastos fixos dos próximos 60 dias), sem valores no texto, e refaz a agenda quando abre ou quando as contas mudam. A hora é aproximada (o app não pede a permissão de alarme exato).

## Ícone e tela de abertura

`node scripts/gerar-icones.mjs` gera as peças de `android-assets/` a partir de `icon-simbolo.svg`.
