import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

// Pin the graph-IR signing key to a per-process temp file so tests never read
// or create a key in the real agent config dir (~/.pi/agent).
process.env.WISP_SIGNING_KEY_FILE = join(tmpdir(), `wisp-test-key-${process.pid}`);

// Mock the Text and Container classes from pi-tui so tests can run without the TUI dependency
vi.mock("@earendil-works/pi-tui", () => ({
  Text: class Text {
    constructor(public content: string) {}
    render = vi.fn(() => this.content);
  },
  Container: class Container {
    render = vi.fn(() => "");
  },
}));
