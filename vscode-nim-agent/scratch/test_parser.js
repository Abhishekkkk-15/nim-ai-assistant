
function normalizeAction(raw) {
    if (!raw || typeof raw !== "object") return null;

    if (raw.tool && typeof raw.tool === "string") {
      return { tool: { name: raw.tool, input: raw.input || {} } };
    }
    
    // Fallback: If the object has a 'command' field but no 'tool', assume 'run_command'
    if (raw.command && !raw.tool) {
      return { tool: { name: "run_command", input: raw } };
    }

    // Fallback: If the object has a 'path' and 'content' but no 'tool', assume 'write_file'
    if (raw.path && raw.content && !raw.tool) {
      return { tool: { name: "write_file", input: raw } };
    }

    if (raw.plan) return { plan: raw.plan };
    if (raw.final) return { final: raw.final };
    return null;
}

function findBareJson(text) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return undefined;
    return text.slice(start, end + 1);
}

function parseActions(text) {
    const actions = [];
    const fenceRegex = /```json\s*([\s\S]*?)```/gi;
    let match;

    while ((match = fenceRegex.exec(text)) !== null) {
      try {
        const raw = JSON.parse(match[1].trim());
        const normalized = normalizeAction(raw);
        if (normalized) actions.push(normalized);
      } catch { /* skip */ }
    }

    if (actions.length === 0) {
      // Fallback 1: Look for XML-like tags <tool_name>{...}</tool_name>
      const tagRegex = /<(\w+)>\s*([\s\S]*?)\s*<\/\1>/gi;
      let tagMatch;
      while ((tagMatch = tagRegex.exec(text)) !== null) {
        const toolName = tagMatch[1];
        const payload = tagMatch[2].trim();
        try {
          const raw = JSON.parse(payload);
          const normalized = raw.tool ? normalizeAction(raw) : { tool: { name: toolName, input: raw } };
          if (normalized) actions.push(normalized);
        } catch { /* skip */ }
      }
    }

    if (actions.length === 0) {
      const bare = findBareJson(text);
      if (bare) {
        try {
          const raw = JSON.parse(bare);
          const normalized = normalizeAction(raw);
          if (normalized) actions.push(normalized);
        } catch { /* skip */ }
      }
    }

    return actions;
}

const testCases = [
    {
        name: "Standard JSON block",
        text: '```json\n{ "tool": "run_command", "input": { "command": "ls" } }\n```'
    },
    {
        name: "XML tags with raw input",
        text: '<run_command>\n{\n"command": "find . -type f"\n}\n</run_command>'
    },
    {
        name: "XML tags with full tool call",
        text: '<write_file>\n{ "tool": "write_file", "input": { "path": "test.ts", "content": "hello" } }\n</write_file>'
    },
    {
        name: "Bare JSON with fallback command",
        text: 'Thinking...\n{\n"command": "ls -la"\n}'
    }
];

testCases.forEach(tc => {
    console.log(`--- Test: ${tc.name} ---`);
    console.log(JSON.stringify(parseActions(tc.text), null, 2));
});
