import { OutlinerClient } from "./client";
import { navigateOutlinerLink } from "./outliner-links";
import { resolvePaths } from "./paths";

interface PluginLinkContext {
  clicked_url?: string;
  focused_pane_cwd?: string;
  workspace_cwd?: string;
}

if (process.env.HERDR_ENV !== "1") {
  throw new Error("Outliner link navigation must run inside Herdr");
}

let context: PluginLinkContext = {};
if (process.env.HERDR_PLUGIN_CONTEXT_JSON) {
  try {
    context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON) as PluginLinkContext;
  } catch {
    throw new Error("Herdr supplied invalid plugin link context");
  }
}
const clickedUrl = context.clicked_url ?? process.env.HERDR_PLUGIN_CLICKED_URL;
if (!clickedUrl) throw new Error("Herdr plugin link context has no clicked URL");

const workspaceRoot = context.focused_pane_cwd ?? context.workspace_cwd ?? process.cwd();
const paths = resolvePaths({ ...process.env, OUTLINER_WORKSPACE_ROOT: workspaceRoot });
const client = new OutlinerClient(paths.socket);
const navigation = await navigateOutlinerLink(client, clickedUrl);
process.stdout.write(`${JSON.stringify({
  focused: true,
  target: navigation.kind,
  id: navigation.id,
  title: navigation.title,
})}\n`);
