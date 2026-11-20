# Pedido de permissão para cortes (modelo)

Use este texto para pedir autorização por **e-mail, DM (Instagram/X) ou Discord** do streamer.
Pequenos criadores costumam aceitar, porque cortes trazem público novo para a live.

**Guarde a resposta (print ou e-mail).** Ela é a prova que vai no `data/clip-permissions.json`.

---

> Olá, [NOME]! Tudo bem?
>
> Meu nome é [SEU NOME], tenho um canal de cortes de GTA no YouTube Shorts e no TikTok ([LINK DO CANAL]).
> Curto muito suas lives e gostaria de pedir sua autorização para postar cortes dos melhores momentos.
>
> Como funcionaria:
> - Cortes de 1 a 1min30, na vertical, com sua webcam em destaque e uma legenda.
> - Sempre com crédito: **@[canal]** e o link da sua Twitch na descrição e no título/legenda.
> - Nada de cortes que te prejudiquem (brigas fora de contexto, conteúdo sensível etc.). Se você pedir pra tirar um vídeo, eu tiro na hora.
>
> Perguntas rápidas:
> 1. Posso postar cortes no **YouTube** e no **TikTok**?
> 2. Posso **monetizar** esses vídeos (programa de parceiros do YouTube / Recompensas para Criadores do TikTok)?
>    Se preferir, posso dividir a receita com você: [X]%.
> 3. Tem alguma regra que eu deva seguir (horários, temas proibidos, hashtag obrigatória)?
>
> Valeu demais! 🙏

---

## Como registrar a resposta

Adicione (ou edite) o canal em `data/clip-permissions.json`:

```json
{
  "login": "nomedocanal",
  "status": "allowed",
  "platformsAllowed": ["youtube", "tiktok"],
  "monetizationAllowed": true,
  "creditRequired": true,
  "rules": ["Marcar @nomedocanal na descrição", "Não postar cortes de briga"],
  "evidence": [
    {
      "source": "written_permission",
      "url": "e-mail de 18/11/2026 / print salvo em docs/permissoes/nomedocanal.png",
      "quote": "Pode postar sim, pode monetizar, só me marca!",
      "checkedAt": "2026-11-18"
    }
  ],
  "tier": "small",
  "notes": "[manual]",
  "updatedAt": "2026-11-18"
}
```

- `monetizationAllowed: true` só se o streamer **disse explicitamente** que pode monetizar. Sem isso, o programa **não posta**.
- Entradas com `source: "written_permission"` ou `notes` contendo `[manual]` **nunca** são sobrescritas pelo scanner.
- Se o streamer negar, registre `"status": "denied"` para o scanner não perguntar de novo.
