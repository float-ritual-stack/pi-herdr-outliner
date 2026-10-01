// Every test service reads extensions only from folders a test gives it: never the owner's real
// ~/.config/pi-herdr-outliner/extensions (its code and secrets). A test that wants a user folder sets
// OUTLINER_EXTENSIONS_DIR itself.
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OUTLINER_EXTENSIONS_DIR ??= join(tmpdir(), `outliner-test-no-user-extensions-${process.pid}`);
