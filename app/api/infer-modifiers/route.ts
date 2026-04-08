import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

export async function POST(request: Request) {
  try {
    const { items, restaurantName } = (await request.json()) as {
      items: { name: string; price: number; group: string }[];
      restaurantName?: string;
    };

    if (!items?.length) {
      return Response.json({ error: "No items provided" }, { status: 400 });
    }

    const itemList = items
      .map((i) => `- ${i.name} ($${i.price.toFixed(2)}) [${i.group}]`)
      .join("\n");

    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: `You are a restaurant menu expert. Based on the following menu items${restaurantName ? ` from "${restaurantName}"` : ""}, suggest modifier templates that would be appropriate.

Menu items:
${itemList}

Return a JSON array of modifier templates. Each template should have:
- name: template name (e.g., "Pizza Toppings", "Meat Temperature")
- sections: array of sections, each with:
  - name: section name
  - min_selections: minimum required (0 for optional)
  - max_selections: maximum allowed
  - modifiers: array of {name, price, is_default}

Rules:
- Only suggest modifiers that make sense for the menu items
- Keep prices reasonable (most customizations $0-3)
- Include a default option in forced-choice sections
- Group related items under one template (e.g., all burgers share "Meat Temperature")
- Don't create a template if fewer than 2 items would use it
- Maximum 5 templates

Return ONLY valid JSON, no markdown or explanation.`,
        },
      ],
    });

    const text =
      msg.content[0].type === "text" ? msg.content[0].text : "";

    // Parse JSON from response (handle potential markdown wrapping)
    let templates;
    try {
      const jsonStr = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      templates = JSON.parse(jsonStr);
    } catch {
      return Response.json(
        { error: "Failed to parse AI response", raw: text },
        { status: 500 },
      );
    }

    return Response.json({
      templates,
      usage: {
        input_tokens: msg.usage.input_tokens,
        output_tokens: msg.usage.output_tokens,
      },
    });
  } catch (error: unknown) {
    return Response.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}
