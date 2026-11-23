import { readFile } from "node:fs/promises";

const { highlights } = JSON.parse(
  await readFile(new URL("./notes/keynote-highlights.json", import.meta.url), "utf8"),
);
const topics = new Map();

for (const { topic, title } of highlights) {
  if (!topics.has(topic)) topics.set(topic, []);
  topics.get(topic).push(title);
}

console.log(
  [...topics]
    .map(([topic, titles]) => `${topic}\n${titles.map((title) => `  - ${title}`).join("\n")}`)
    .join("\n\n"),
);
