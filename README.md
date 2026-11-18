# OpenCode Agent Time

**Quanto tempo seus agentes de IA realmente trabalharam?**

O **OpenCode Agent Time** é um plugin para a interface de terminal (TUI) do **OpenCode 2.3.0** que mostra, diretamente na sidebar, o tempo de execução dos agentes de uma sessão — incluindo subagentes e tarefas em paralelo.

Criei o plugin durante meus experimentos com equipes de agentes. Eu precisava enxergar, ao mesmo tempo, o tempo de cada agente e o total acumulado da sessão. As alternativas que encontrei não apresentavam essa combinação da forma que eu buscava.

A proposta é simples: **mais visibilidade sobre a execução, sem confundir tempo com custo ou consumo de tokens.**

## O que você acompanha

- **Tempo total:** soma do tempo de execução observado na sessão principal e em seus descendentes, inclusive quando há agentes em paralelo.
- **Tempo por agente:** todos os agentes participantes aparecem individualmente, sem reduzir a lista a um resumo `+N agentes`. A soma desses tempos corresponde ao total exibido.
- **Tempo por modelo LLM:** agrupamento por provedor e modelo (`providerID/modelID`). A sidebar mostra até quatro modelos e resume os demais em `+N modelos`.
- **Estado da execução:** `Running` quando há algum passo ativo na família de sessões; `Paused` quando não há. Não significa necessariamente que alguém pausou a sessão manualmente.
- **Continuidade:** as medições observadas são preservadas ao usar `/reload`, reiniciar o OpenCode ou reabrir a sessão.

**Como interpretar o total:** se dois agentes executam tarefas simultaneamente por cinco minutos cada, o tempo acumulado pode chegar a dez minutos. Portanto, o total representa **tempo somado de execução dos agentes**, não o tempo decorrido no relógio. A espera do agente principal por um subagente é descontada para evitar contagem duplicada.

A seção por modelo é outra forma de agrupar **os mesmos períodos de execução**. Não some os valores por modelo aos valores por agente.

O indicador `~` sinaliza uma medida parcial; `—` indica ausência de tempo acumulado. Se não for possível obter uma medida confiável, o plugin informa o erro em vez de inventar um valor. O tempo de ferramentas comuns continua associado ao passo do agente.

## Instalação local

**Pré-requisito:** OpenCode **2.3.0**. O plugin ainda não foi publicado em um registro de pacotes; a instalação documentada e validada é por **pasta local**.

1. Coloque os arquivos do repositório em um diretório permanente, por exemplo `/caminho/absoluto/opencode-agent-time`.
2. Adicione esse diretório à lista de plugins em `~/.config/opencode/cli.json`:

   ```json
   {
     "$schema": "https://opencode.ai/v2/cli.json",
     "plugins": ["/caminho/absoluto/opencode-agent-time"]
   }
   ```

3. Execute `/reload` na TUI ou reinicie o OpenCode.
4. Abra uma sessão e localize o bloco **Agent time** na sidebar.

> Use um **caminho absoluto**: o JSON não expande `~`. Não é necessário rodar `npm install`, `bun install` ou fazer build para carregar o plugin. Se você já possui outros plugins configurados, mantenha-os na lista.

O plugin registra seu conteúdo no slot nativo `sidebar.content` e remove o registro ao ser descarregado, evitando duplicação após `/reload`.

### Idioma (opcional)

O padrão é inglês (`Running` / `Paused`). Para usar português, configure o idioma de forma explícita:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    {
      "package": "/caminho/absoluto/opencode-agent-time",
      "options": { "locale": "pt-BR" }
    }
  ]
}
```

São aceitos `pt`, `pt-BR` e `pt-PT`, com os estados `Em execução` / `Pausado`. Outros valores usam inglês. O idioma **não é detectado automaticamente** do sistema ou do OpenCode.

Veja também `examples/cli.local.json` e `examples/cli.local.pt-BR.json`.

## Como funciona a medição

O OpenCode Agent Time registra **eventos observados durante a execução**. Ele não estima tempo perdido nem reconstrói o histórico de sessões anteriores à sua ativação.

No contrato do OpenCode 2.3.0, o plugin utiliza:

- Eventos `session.step.*` para identificar o início, o fim e as falhas dos passos, além do agente e modelo utilizados.
- Eventos `session.execution.*` para delimitar os períodos de atividade, excluindo ociosidade e suspensões.
- Eventos `session.tool.input.started` e `session.tool.called` para identificar e correlacionar delegações `subagent` / `task` sem duplicar a espera do agente principal.

O tempo por modelo usa o provedor e o modelo registrados **em cada passo**, não o modelo selecionado posteriormente na sessão. Isso evita atribuições incorretas quando há trocas de modelo.

Os dados observados ficam em:

```text
~/.local/state/opencode/<channel>/tui/plugin.agent-time.timeline.json
```

`<channel>` é o canal de execução do OpenCode, como `latest`. O arquivo preserva as medições e os metadados entre recargas e reinícios; registros antigos sem informações de modelo continuam legíveis, mas não exibem essa dimensão. Não há migração ou limpeza automática dos dados antigos. Ao reabrir uma sessão ociosa, um passo aberto é encerrado na última atividade observada, e não no momento da reabertura.

<details>
<summary>Detalhes técnicos sobre a correlação dos eventos</summary>

Os eventos `session.step.started` contêm o agente e o modelo utilizado naquele passo (`providerID` e `id`; a variante não é usada no agrupamento). Delegações emitem seus próprios eventos, com agente e modelo do filho.

O evento `session.tool.input.started` informa o nome da ferramenta; `session.tool.called` marca o início efetivo da chamada, mas não traz o nome. Por isso, apenas chamadas identificadas como `subagent` ou `task` geram intervalos de espera. A correlação usa o identificador da chamada dentro da sessão e do passo, **não o horário** — inclusive quando várias chamadas começam no mesmo milissegundo.

</details>

## Limitações importantes

- A coleta só ocorre **enquanto a TUI que executa o plugin está aberta**. Eventos não observados não são recuperados depois.
- Use **uma instância de TUI por máquina** para evitar sobrescrita do arquivo de medições.
- Operações que não emitem os eventos de passo do OpenCode, como certas chamadas de compactação, geração de título ou processos externos, não entram na medição por modelo.
- Em relógios local e remoto desalinhados, a leitura em tempo real pode sofrer diferenças.
- A consulta da árvore de sessões tem limites de segurança: **8 níveis, 200 sessões e 64 páginas**. Falhas ou truncamentos são apresentados como erro, não como resultado parcial silencioso.
- Este plugin funciona **somente na TUI**. Não adiciona ferramentas nem hooks ao servidor.

## Desenvolvimento e testes

O projeto utiliza **Bun** (testado com **1.3.14**):

```sh
bun test
bun run build
```

Os testes cobrem contratos de eventos, agentes paralelos, delegações, contagem sem duplicidade, status, persistência, idiomas, modelos LLM e listagem completa dos agentes. O build verifica a transpilação e gera `dist/` apenas para validação — esse diretório não é necessário para executar o plugin.

A integração também foi exercitada em uma TUI real isolada, com provedor mock local, sem consumir um LLM pago.

**Compatibilidade validada:** OpenCode **2.3.0**. Outras versões não foram testadas.

## Contribuições

Sugestões, relatos de problemas e contribuições são bem-vindos. Ao abrir uma issue, informe a versão do OpenCode, o comportamento observado e, se possível, os passos para reproduzi-lo. Remova dados sensíveis antes de compartilhar logs ou capturas de tela.

## Licença

Distribuído sob a **licença MIT**. Consulte o arquivo [LICENSE](LICENSE).
