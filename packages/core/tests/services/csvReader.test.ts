import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCsvFiles, readCsvFile } from "../../src/services/csvReader.js";

let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "csvreader-"));
  await fs.writeFile(
    join(dir, "stories.csv"),
    'type,title,description\nUser Story,"Add, SSO","line1\nline2"\nTask,Wire OIDC,do it\n'
  );
  await fs.writeFile(join(dir, "notes.txt"), "ignore me");
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("listCsvFiles", () => {
  it("lists only .csv files with metadata", async () => {
    const files = await listCsvFiles(dir);
    expect(files.map((f) => f.name)).toEqual(["stories.csv"]);
    expect(files[0].sizeBytes).toBeGreaterThan(0);
    expect(typeof files[0].modified).toBe("string");
  });
});

describe("readCsvFile", () => {
  it("parses headers and rows, handling quoted commas and embedded newlines", async () => {
    const table = await readCsvFile(dir, "stories.csv", 1_000_000);
    expect(table.headers).toEqual(["type", "title", "description"]);
    expect(table.rowCount).toBe(2);
    expect(table.rows[0]).toEqual({
      type: "User Story",
      title: "Add, SSO",
      description: "line1\nline2"
    });
    expect(table.rows[1].title).toBe("Wire OIDC");
  });

  it("rejects a filename with a path separator", async () => {
    await expect(readCsvFile(dir, "../secret.csv", 1_000_000)).rejects.toThrow(/invalid filename/);
    await expect(readCsvFile(dir, "sub/stories.csv", 1_000_000)).rejects.toThrow(
      /invalid filename/
    );
  });

  it("rejects an absolute path", async () => {
    await expect(readCsvFile(dir, "/etc/passwd", 1_000_000)).rejects.toThrow(
      /invalid filename|only .csv/
    );
  });

  it("rejects a non-.csv extension", async () => {
    await expect(readCsvFile(dir, "notes.txt", 1_000_000)).rejects.toThrow(/only .csv/);
  });

  it("rejects a file larger than maxBytes", async () => {
    await expect(readCsvFile(dir, "stories.csv", 5)).rejects.toThrow(/exceeds/);
  });

  it("rejects a backslash path even where the OS separator is '/'", async () => {
    await expect(readCsvFile(dir, "evil\\path.csv", 1_000_000)).rejects.toThrow(/invalid filename/);
  });

  it("returns empty headers and rows for an empty CSV file", async () => {
    await fs.writeFile(join(dir, "empty.csv"), "");
    const table = await readCsvFile(dir, "empty.csv", 1_000_000);
    expect(table).toEqual({ headers: [], rows: [], rowCount: 0 });
  });

  it("rejects a symlink that points outside the directory", async () => {
    const outside = join(tmpdir(), "csvreader-secret-target.csv");
    await fs.writeFile(outside, "a,b\n1,2\n");
    await fs.symlink(outside, join(dir, "link.csv"));
    await expect(readCsvFile(dir, "link.csv", 1_000_000)).rejects.toThrow(
      /escapes the CSV directory/
    );
    await fs.rm(outside, { force: true });
  });
});
