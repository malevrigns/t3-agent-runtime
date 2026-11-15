import type { RegisteredTool, ToolDefinition, ToolRegistry } from './ports.js';

export class InMemoryToolRegistry implements ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  register(def: ToolDefinition): void {
    if (this.tools.has(def.name)) {
      throw new Error(`Tool with name '${def.name}' already registered`);
    }

    const validate = (args: unknown): { valid: boolean; errors?: string[] } => {
      if (typeof args !== 'object' || args === null) {
        return { valid: false, errors: ['arguments must be an object'] };
      }
      const schema = def.inputSchema;
      const required = Array.isArray(schema.required) ? schema.required : [];
      const errors: string[] = [];

      for (const req of required) {
        if (!(req in (args as Record<string, unknown>))) {
          errors.push(`missing required property '${req}'`);
        }
      }

      const properties = (schema.properties as Record<string, any>) || {};
      for (const [key, propSchema] of Object.entries(properties)) {
        if (key in (args as Record<string, unknown>)) {
          const val = (args as Record<string, unknown>)[key];
          if (propSchema.type === 'string' && typeof val !== 'string') {
            errors.push(`property '${key}' must be string`);
          } else if (propSchema.type === 'number' && typeof val !== 'number') {
            errors.push(`property '${key}' must be number`);
          } else if (propSchema.type === 'boolean' && typeof val !== 'boolean') {
            errors.push(`property '${key}' must be boolean`);
          } else if (propSchema.type === 'array' && !Array.isArray(val)) {
            errors.push(`property '${key}' must be array`);
          } else if (propSchema.type === 'object' && (typeof val !== 'object' || val === null || Array.isArray(val))) {
            errors.push(`property '${key}' must be object`);
          }
        }
      }

      return errors.length > 0 ? { valid: false, errors } : { valid: true };
    };

    this.tools.set(def.name, { def, validate });
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  list(filter?: { names?: string[] }): RegisteredTool[] {
    const all = Array.from(this.tools.values());
    if (!filter?.names) return all;
    const nameSet = new Set(filter.names);
    return all.filter((t) => nameSet.has(t.def.name));
  }

  toModelSpecs(names?: string[]): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
    return this.list(names ? { names } : undefined).map((t) => ({
      name: t.def.name,
      description: t.def.description,
      inputSchema: t.def.inputSchema,
    }));
  }
}
