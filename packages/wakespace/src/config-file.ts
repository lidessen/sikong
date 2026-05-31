import { join } from "node:path";
import { YAML } from "bun";

export function isYamlFile(name: string): boolean {
  return name.endsWith(".yaml") || name.endsWith(".yml");
}

export function isDataFile(name: string): boolean {
  return isYamlFile(name) || name.endsWith(".json");
}

export function parseDataFile<T>(text: string, file: string): T {
  return (isYamlFile(file) ? YAML.parse(text) : JSON.parse(text)) as T;
}

export function dataFileCandidates(root: string, basename: string): string[] {
  return [join(root, `${basename}.yaml`), join(root, `${basename}.yml`), join(root, `${basename}.json`)];
}

export function yamlFile(root: string, basename: string): string {
  return join(root, `${basename}.yaml`);
}

export function stringifyYaml(value: unknown): string {
  return YAML.stringify(value, null, 2);
}
