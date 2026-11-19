# Histórico de versões

## 2.0.0 "Noite Orologia"

A versão com que o Orolon Caixinhas entra na Google Play. O app ficou com cara nova, ganhou uma tela de gráficos, um jeito de usar no computador de verdade e um widget no Android. Seus dados, o tema escolhido, o PIN e a pasta do backup continuam como estavam: nada muda no que fica guardado.

### Visual
- **Visual novo em todas as telas:** fundo com um brilho suave no alto, cartões translúcidos e cada caixinha tingida com a sua cor.
- **Início com arco:** o mostrador virou uma meia-lua em que cada pedaço é uma caixinha, na cor dela. Um marcador mostra em que ponto do mês você está. No centro ficam a sobra e quanto dá para gastar por dia.
- **Ritmo do mês:** uma etiqueta diz se você está acima ou abaixo do ritmo (o limite do mês dividido pelos dias), e um gráfico compara o que já foi gasto com o ritmo ideal.
- **Caixinhas em blocos** com um anel pequeno, o nome e quanto sobra. No Início também aparecem os **últimos gastos**.
- **Barra de baixo flutuante** com o botão **+** no meio para lançar um gasto. Os Ajustes ficam na engrenagem do topo.
- **Mês:** tocar num lançamento abre a edição, que agora tem o botão de apagar. A lista ficou mais limpa, sem os links "Editar" e "Apagar" em cada linha.
- A tela "Metas e investimentos" passou a se chamar **Metas**.

### No computador
- **Barra lateral** com todas as telas e o botão "+ Lançar".
- **Início em duas colunas**, com o arco, o ritmo e os últimos 6 meses de um lado e as caixinhas, as contas a vencer e os últimos gastos do outro.
- Mês, Cartão, Metas, Calculadoras e Ajustes aproveitam a largura da tela.
- **Atalhos de teclado:** **N** lança um gasto, **/** abre a busca do Mês, **Esc** volta um passo e **1** a **5** trocam entre Início, Mês, Gráficos, Cartão e Metas. Eles não disparam enquanto você digita.

### Gráficos
- **Tela própria de Gráficos**, sempre do mês escolhido:
  - **Ritmo do mês**, maior;
  - **Para onde foi:** uma rosca com a parte de cada caixinha;
  - **Últimos 6 meses:** o gasto de cada mês com a linha do limite; mês que passou do limite aparece em destaque;
  - **Dias do mês:** um calendário em que o dia fica mais forte quanto mais se gastou. Tocar num dia mostra a lista só daquele dia;
  - **Por forma de pagamento** e a comparação com o mês anterior, por caixinha.
- Tocar (ou passar o mouse) num ponto de qualquer gráfico mostra o valor. Dá para andar pelos pontos com o teclado, e o leitor de tela lê os valores.
- **Financiamento:** um gráfico novo mostra o saldo devedor ao longo do prazo, no SAC e no PRICE, e quanto a amortização extra encurta cada um.
- Os gráficos do Cartão e do simulador de juros seguem o mesmo desenho.

### Temas
- **Seis temas novos:** Ametista, Musgo e Grafite (escuros) e Areia, Névoa e Lírio (claros). São 14 ao todo, todos livres.
- A **galeria** mostra cada tema como uma miniatura do Início.
- Temas próprios podem ter a cor do **brilho do fundo**. Temas antigos e os do Orolon Player continuam valendo.
- **Visual leve:** uma chave em Ajustes › Aparência tira brilhos, degradês, sombras e desfoque. Ela liga sozinha se o aparelho mostrar que está lento ao abrir o app, avisa uma vez, e não liga de novo se você desligar.

### Movimento
- O arco e os anéis se enchem, os números contam até o valor, os gráficos se desenham ao aparecer, a troca de tela tem uma passagem curta e a folha de lançar entra com uma mola leve.
- Com "reduzir movimento" ligado no aparelho, nada se move: tudo aparece pronto.

### Android
- **Widget "Lançar gasto"** para a tela inicial: um botão que abre o app direto na folha de lançar e, embaixo, a sobra do mês e quanto dá por dia. Com o PIN ligado, o widget não mostra valores, e o app pede o PIN antes de abrir a folha.
- **Ícone próprio na notificação** dos lembretes de contas a vencer.
- O **APK de teste** agora se chama "Orolon Caixinhas (teste)" e fica instalado ao lado do app da Google Play, cada um com os seus dados. Os dados de um APK de teste anterior à 2.0 não passam sozinhos para o novo: exporte um backup no antigo e importe no novo.
- O link de apoio pelo GitHub fica só no site.
- Continua sem a permissão de internet.

### Correções
- **Backup sem caixinhas:** importar um backup que não tinha nenhuma caixinha fazia o app parar de abrir. Agora ele abre com as caixinhas de fábrica.
- **Gasto de uma caixinha apagada:** editar esse gasto podia passá-lo para outra caixinha sem você ver. Agora a folha mostra "Caixinha apagada" e o gasto só muda de caixinha se você escolher outra.
- **Forma de pagamento removida:** editar um gasto pago com uma forma que você já tinha tirado da lista podia trocar a forma sem avisar. Agora a forma do gasto continua a mesma até você mudar, e ela não aparece mais nos lançamentos novos.
- Um tema guardado com defeito no aparelho não impede mais o app de abrir.
- Na Aparência, a galeria tem duas colunas também em celular estreito.
- O nome do mês fica ao lado das setas em todos os temas, inclusive nos que usam a fonte do sistema.

## 1.9.0
- **Calculadoras** numa tela só: contas CLT, **financiamento de imóvel** (SAC e PRICE lado a lado, com correção, amortização extra e aviso quando a parcela passa de 30% da renda), juros compostos e "quanto guardar por mês".
- **A vencer:** o Início avisa das faturas e dos gastos fixos que vencem nos próximos 7 dias.
- **Ajustes em partes:** Caixinhas, Pagamento e rendimento, Aparência, Bloqueio por PIN, Backup e dados, Lembretes e Sobre.
- A lista do Mês mostra os 8 lançamentos mais recentes e o resto a pedido.
- **App Android (em teste):** voltar fecha uma coisa por vez, backup e planilha saem pelo compartilhamento, backup automático numa pasta escolhida e lembrete de contas a vencer por notificação. Sem permissão de internet.

## 1.8
- **Movimento:** ao abrir o app o mostrador gira e se desenha, e a sobra conta até o valor. Ao lançar, o pedaço da caixinha cresce; se ela estoura, treme e mostra "passou R$ X". Meta batida ganha brilho, e os gráficos se desenham ao aparecer. Com "reduzir movimento", tudo parado.
- 1.8.1 a 1.8.4: acertos do movimento, caixas de marcar com o texto em linha, ícone novo também na aba do navegador e o aviso "passou" sem cortes em nomes compridos.

## 1.7.0
- **Backup automático:** uma cópia por dia neste aparelho (7 dias) e mais uma antes de importar ou apagar tudo. No Chrome e no Edge do computador, dá para escolher uma pasta e o app grava ali um arquivo por dia.
- O app passou a se chamar **Orolon Caixinhas**.

## 1.6.0
- **Visual novo:** um mostrador grande em que cada pedaço do anel é uma caixinha, telas mais limpas e ícone novo, irmão do ícone do Orolon Player.

## 1.5
- **Lançar de qualquer tela:** um botão sempre à mão abre a folha com valor, caixinha e o aviso de "cabe / não cabe". Editar um gasto usa a mesma folha.
- **Início mais direto:** a sobra do mês, as caixinhas, a fatura, as metas e atalhos.
- **Caixinhas com ícone:** 27 desenhos, na cor de cada caixinha.
- 1.5.1: barra com 5 abas, Calculadoras no Início e textos revisados.

## Antes da 1.5
- 1.4: busca e filtros nos lançamentos, gráficos, planilha CSV e bloqueio por PIN.
- 1.3: Início, entradas de dinheiro, gastos fixos, edição de gastos, galeria de temas, guia "Como usar", botões "?" de ajuda e caixinhas à sua maneira.
- Primeiras versões: caixinhas com limite, cartão e parcelas, metas, calculadoras CLT e os temas Orologia Noite e Dia.
