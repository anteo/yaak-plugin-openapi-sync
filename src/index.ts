import { readFileSync } from "node:fs";
import type {
  Context,
  DynamicPromptFormArg,
  Folder,
  HttpRequest,
  HttpUrlParameter,
  PartialImportResources,
  PluginDefinition,
  WorkspaceActionPlugin,
} from "@yaakapp/api";
import type { ImportPluginResponse } from "@yaakapp/api/lib/plugins/ImporterPlugin";
import { convertPostman } from "../../yaak/plugins/importer-postman/src";
import { convert } from "openapi-to-postmanv2";

type RequestResource = PartialImportResources["httpRequests"][number];
type FolderResource = PartialImportResources["folders"][number];
type DiffEntry = {
  key: string;
  label: string;
  description: string;
  folderPath: string | null;
  method: string;
  path: string;
  request: RequestResource;
};
type ParamChangeEntry = {
  key: string;
  label: string;
  requestId: string;
  params: HttpUrlParameter[];
};
type EndpointDiff = {
  added: DiffEntry[];
  deleted: DiffEntry[];
  paramAdditions: ParamChangeEntry[];
  paramDeletions: ParamChangeEntry[];
};

const LAST_URL_STORE_KEY = "openapi-sync.last-url";

export const plugin: PluginDefinition = {
  workspaceActions: [createSyncAction()],
};

export async function convertOpenApi(
  contents: string,
): Promise<ImportPluginResponse | undefined> {
  // oxlint-disable-next-line no-explicit-any
  let postmanCollection: any;
  try {
    postmanCollection = await new Promise((resolve, reject) => {
      // oxlint-disable-next-line no-explicit-any
      convert({ type: "string", data: contents }, {}, (err, result: any) => {
        if (err != null) reject(err);

        if (Array.isArray(result.output) && result.output.length > 0) {
          resolve(result.output[0].data);
        }
      });
    });
  } catch {
    return undefined;
  }

  return convertPostman(JSON.stringify(postmanCollection));
}

function createSyncAction(): WorkspaceActionPlugin {
  return {
    label: "Sync with OpenAPI...",
    icon: "info",
    async onSelect(ctx, args) {
      const workspaceId = args.workspace.id;
      const lastUrl = await ctx.store.get<string>(LAST_URL_STORE_KEY);
      const specUrl = await ctx.prompt.text({
        id: "openapi-sync.url",
        title: "Sync with OpenAPI...",
        label: "Specify OpenAPI URL",
        placeholder: "https://example.com/openapi.json",
        defaultValue: lastUrl ?? "",
        required: true,
        confirmText: "Proceed",
      });
      if (specUrl == null) return;

      await ctx.store.set(LAST_URL_STORE_KEY, specUrl);

      const contents = await fetchOpenApiSpec(ctx, specUrl);
      const imported = await convertOpenApi(contents);
      if (imported == null) {
        throw new Error(`Remote URL did not produce a valid OpenAPI import: ${specUrl}`);
      }

      const filteredResources = filterHttpOnlyResources(imported.resources);
      const existingRequests = await ctx.httpRequest.list();
      const existingFolders = await ctx.folder.list();
      const diff = diffWorkspaceEndpoints({
        workspaceId,
        existingRequests,
        existingFolders,
        importedRequests: filteredResources.httpRequests,
        importedFolders: filteredResources.folders,
      });

      const selection = await promptForSelection(ctx, specUrl, diff);
      if (selection == null) return;

      const addedKeys = new Set(selection.addedKeys);
      const deletedKeys = new Set(selection.deletedKeys);
      const paramAdditionKeys = new Set(selection.paramAdditionKeys);
      const paramDeletionKeys = new Set(selection.paramDeletionKeys);
      const selectedAdded = diff.added.filter((entry) => addedKeys.has(entry.key));
      const selectedDeleted = diff.deleted.filter((entry) => deletedKeys.has(entry.key));
      const selectedParamAdditions = diff.paramAdditions.filter((entry) =>
        paramAdditionKeys.has(entry.key),
      );
      const selectedParamDeletions = diff.paramDeletions.filter((entry) =>
        paramDeletionKeys.has(entry.key),
      );

      if (
        selectedAdded.length === 0 &&
        selectedDeleted.length === 0 &&
        selectedParamAdditions.length === 0 &&
        selectedParamDeletions.length === 0
      ) {
        await ctx.toast.show({
          color: "info",
          message: "No changes selected",
        });
        return;
      }

      const applyResult = await applySelectedChanges(ctx, {
        workspaceId,
        existingRequests,
        existingFolders,
        added: selectedAdded,
        deleted: selectedDeleted,
        paramAdditions: selectedParamAdditions,
        paramDeletions: selectedParamDeletions,
      });

      await ctx.toast.show({
        color: "success",
        message:
          `OpenAPI sync applied ${applyResult.added} additions, ` +
          `${applyResult.deleted} deletions, ` +
          `${applyResult.paramAdditions} parameter additions, and ` +
          `${applyResult.paramDeletions} parameter deletions`,
      });
    },
  };
}

async function fetchOpenApiSpec(ctx: Context, specUrl: string): Promise<string> {
  const response = await ctx.httpRequest.send({
    httpRequest: {
      method: "GET",
      url: specUrl,
      workspaceId: "",
      authenticationType: "none",
      headers: [{ name: "Accept", value: "application/json, application/yaml, text/yaml, */*" }],
    },
  });

  if (response.error) {
    throw new Error(`Failed to fetch OpenAPI spec: ${response.error}`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Failed to fetch OpenAPI spec with status ${response.status}`);
  }
  if (response.bodyPath == null) {
    throw new Error("OpenAPI spec response did not include a readable body");
  }

  return readFileSync(response.bodyPath, "utf8");
}

function filterHttpOnlyResources(resources: PartialImportResources): PartialImportResources {
  return {
    workspaces: resources.workspaces,
    environments: [],
    folders: resources.folders,
    httpRequests: resources.httpRequests,
    grpcRequests: [],
    websocketRequests: [],
  };
}

export function diffWorkspaceEndpoints(args: {
  workspaceId: string;
  existingRequests: HttpRequest[];
  existingFolders: Folder[];
  importedRequests: RequestResource[];
  importedFolders: FolderResource[];
}): EndpointDiff {
  const { workspaceId, existingRequests, existingFolders, importedRequests, importedFolders } = args;
  const workspaceRequests = existingRequests.filter((request) => request.workspaceId === workspaceId);
  const workspaceFolders = existingFolders.filter((folder) => folder.workspaceId === workspaceId);
  const importedFolderPathById = buildImportedFolderPathMap(importedFolders);
  const existingFolderPathById = buildExistingFolderPathMap(workspaceFolders);

  const importedByKey = new Map<string, DiffEntry>();
  for (const request of importedRequests) {
    const key = endpointKeyForRequest(request.method ?? "GET", request.url ?? "");
    if (importedByKey.has(key)) continue;
    const method = (request.method ?? "GET").toUpperCase();
    const path = normalizeUrlPath(request.url ?? "");
    const folderPath = request.folderId ? importedFolderPathById.get(request.folderId) ?? null : null;
    importedByKey.set(key, {
      key,
      label: formatEndpointLabel(method, path),
      description: describeRequest(request.name, folderPath),
      folderPath,
      method,
      path,
      request,
    });
  }

  const existingByKey = new Map<string, DiffEntry>();
  for (const request of workspaceRequests) {
    const key = endpointKeyForRequest(request.method, request.url);
    if (existingByKey.has(key)) continue;
    const method = request.method.toUpperCase();
    const path = normalizeUrlPath(request.url);
    const folderPath = request.folderId ? existingFolderPathById.get(request.folderId) ?? null : null;
    existingByKey.set(key, {
      key,
      label: formatEndpointLabel(method, path),
      description: describeRequest(request.name, folderPath),
      folderPath,
      method,
      path,
      request,
    });
  }

  const added = [...importedByKey.entries()]
    .filter(([key]) => !existingByKey.has(key))
    .map(([, entry]) => entry)
    .sort(sortDiffEntries);
  const deleted = [...existingByKey.entries()]
    .filter(([key]) => !importedByKey.has(key))
    .map(([, entry]) => entry)
    .sort(sortDiffEntries);
  const paramAdditions = [...existingByKey.entries()]
    .filter(([key]) => importedByKey.has(key))
    .map(([, existingEntry]) => {
      const importedEntry = importedByKey.get(existingEntry.key);
      if (importedEntry == null || existingEntry.request.id == null) return null;

      const missingParams = getMissingParams(
        existingEntry.request.urlParameters ?? [],
        importedEntry.request.urlParameters ?? [],
      );
      if (missingParams.length === 0) return null;

      return {
        key: existingEntry.key,
        label: `${existingEntry.label} (+ ${formatParameterList(missingParams)})`,
        requestId: existingEntry.request.id,
        params: missingParams,
      } satisfies ParamChangeEntry;
    })
    .filter((entry): entry is ParamChangeEntry => entry != null)
    .sort((a, b) => a.key.localeCompare(b.key));
  const paramDeletions = [...existingByKey.entries()]
    .filter(([key]) => importedByKey.has(key))
    .map(([, existingEntry]) => {
      const importedEntry = importedByKey.get(existingEntry.key);
      if (importedEntry == null || existingEntry.request.id == null) return null;

      const extraParams = getExtraParams(
        existingEntry.request.urlParameters ?? [],
        importedEntry.request.urlParameters ?? [],
      );
      if (extraParams.length === 0) return null;

      return {
        key: existingEntry.key,
        label: `${existingEntry.label} (- ${formatParameterList(extraParams)})`,
        requestId: existingEntry.request.id,
        params: extraParams,
      } satisfies ParamChangeEntry;
    })
    .filter((entry): entry is ParamChangeEntry => entry != null)
    .sort((a, b) => a.key.localeCompare(b.key));

  return { added, deleted, paramAdditions, paramDeletions };
}

function sortDiffEntries(a: DiffEntry, b: DiffEntry): number {
  return a.path.localeCompare(b.path) || a.method.localeCompare(b.method);
}

function describeRequest(name: string | undefined, folderPath: string | null): string {
  const details: string[] = [];
  if (name != null && name.trim() !== "") {
    details.push(`Request: ${name}`);
  }
  if (folderPath != null && folderPath !== "") {
    details.push(`Folder: ${folderPath}`);
  }
  return details.join(" | ");
}

function formatEndpointLabel(method: string, path: string): string {
  return `${path} [${method}]`;
}

export function endpointKeyForRequest(method: string, url: string): string {
  return `${method.toUpperCase()} ${normalizeUrlPath(url)}`;
}

export function normalizeUrlPath(url: string): string {
  const trimmed = url.trim();
  if (trimmed === "") return "/";

  const withoutQuery = trimmed.split(/[?#]/, 1)[0] ?? trimmed;

  let path = withoutQuery;
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(withoutQuery)) {
    try {
      path = new URL(withoutQuery).pathname;
    } catch {
      path = withoutQuery.replace(/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\/[^/]+/, "");
    }
  }

  if (!path.startsWith("/")) {
    path = `/${path}`;
  }

  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the raw path if it contains invalid escape sequences.
  }

  path = path.replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }

  return path || "/";
}

function buildImportedFolderPathMap(folders: FolderResource[]): Map<string, string> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const cache = new Map<string, string>();

  const resolve = (folderId: string): string => {
    const cached = cache.get(folderId);
    if (cached != null) return cached;

    const folder = byId.get(folderId);
    if (folder == null) return "";
    const parent = folder.folderId ? resolve(folder.folderId) : "";
    const path = parent ? `${parent}/${folder.name}` : folder.name;
    cache.set(folderId, path);
    return path;
  };

  for (const folder of folders) {
    resolve(folder.id);
  }

  return cache;
}

function buildExistingFolderPathMap(folders: Folder[]): Map<string, string> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const cache = new Map<string, string>();

  const resolve = (folderId: string): string => {
    const cached = cache.get(folderId);
    if (cached != null) return cached;

    const folder = byId.get(folderId);
    if (folder == null) return "";
    const parent = folder.folderId ? resolve(folder.folderId) : "";
    const path = parent ? `${parent}/${folder.name}` : folder.name;
    cache.set(folderId, path);
    return path;
  };

  for (const folder of folders) {
    resolve(folder.id);
  }

  return cache;
}

async function promptForSelection(
  ctx: Context,
  specUrl: string,
  diff: EndpointDiff,
): Promise<{
  addedKeys: string[];
  deletedKeys: string[];
  paramAdditionKeys: string[];
  paramDeletionKeys: string[];
} | null> {
  const hasChanges =
    diff.added.length > 0 ||
    diff.deleted.length > 0 ||
    diff.paramAdditions.length > 0 ||
    diff.paramDeletions.length > 0;
  const inputs: DynamicPromptFormArg[] = [
    {
      type: "markdown",
      content: [
        `Comparing workspace against \`${specUrl}\`.`,
        "",
        `Added endpoints: **${diff.added.length}**`,
        `Deleted endpoints: **${diff.deleted.length}**`,
        `Parameter additions: **${diff.paramAdditions.length}**`,
        `Parameter deletions: **${diff.paramDeletions.length}**`,
        ...(hasChanges ? [] : ["", "No endpoint or parameter changes were found."]),
      ].join("\n"),
    },
  ];

  if (diff.added.length > 0) {
    inputs.push({
      type: "accordion",
      label: `Skip additions (${diff.added.length})`,
      inputs: diff.added.map((entry) => ({
        type: "checkbox",
        name: checkboxName("add", entry.key),
        label: `Skip ${entry.label}`,
      })),
    });
  }

  if (diff.deleted.length > 0) {
    inputs.push({
      type: "accordion",
      label: `Delete endpoints (${diff.deleted.length})`,
      inputs: diff.deleted.map((entry) => ({
        type: "checkbox",
        name: checkboxName("delete", entry.key),
        label: entry.label,
        defaultValue: "false",
      })),
    });
  }

  if (diff.paramAdditions.length > 0) {
    inputs.push({
      type: "accordion",
      label: `Skip parameter additions (${diff.paramAdditions.length})`,
      inputs: diff.paramAdditions.map((entry) => ({
        type: "checkbox",
        name: checkboxName("param-add", entry.key),
        label: `Skip ${entry.label}`,
      })),
    });
  }

  if (diff.paramDeletions.length > 0) {
    inputs.push({
      type: "accordion",
      label: `Delete parameters (${diff.paramDeletions.length})`,
      inputs: diff.paramDeletions.map((entry) => ({
        type: "checkbox",
        name: checkboxName("param-delete", entry.key),
        label: entry.label,
        defaultValue: "false",
      })),
    });
  }

  const values = await ctx.prompt.form({
    id: "openapi-sync.review",
    title: "Review OpenAPI Changes",
    confirmText: hasChanges ? "Apply" : "Close",
    cancelText: "Cancel",
    size: "lg",
    inputs,
  });
  if (values == null) return null;
  if (!hasChanges) return null;

  return {
    addedKeys: diff.added
      .filter((entry) => values[checkboxName("add", entry.key)] !== true)
      .map((entry) => entry.key),
    deletedKeys: diff.deleted
      .filter((entry) => values[checkboxName("delete", entry.key)] === true)
      .map((entry) => entry.key),
    paramAdditionKeys: diff.paramAdditions
      .filter((entry) => values[checkboxName("param-add", entry.key)] !== true)
      .map((entry) => entry.key),
    paramDeletionKeys: diff.paramDeletions
      .filter((entry) => values[checkboxName("param-delete", entry.key)] === true)
      .map((entry) => entry.key),
  };
}

function checkboxName(
  prefix: "add" | "delete" | "param-add" | "param-delete",
  key: string,
): string {
  return `${prefix}:${key}`;
}

async function applySelectedChanges(
  ctx: Context,
  args: {
    workspaceId: string;
    existingRequests: HttpRequest[];
    existingFolders: Folder[];
    added: DiffEntry[];
    deleted: DiffEntry[];
    paramAdditions: ParamChangeEntry[];
    paramDeletions: ParamChangeEntry[];
  },
): Promise<{ added: number; deleted: number; paramAdditions: number; paramDeletions: number }> {
  const { workspaceId, existingRequests, existingFolders, added, deleted, paramAdditions, paramDeletions } =
    args;
  const workspaceFolders = existingFolders.filter((folder) => folder.workspaceId === workspaceId);
  const workspaceRequests = existingRequests.filter((request) => request.workspaceId === workspaceId);
  const folderPathById = buildExistingFolderPathMap(workspaceFolders);
  const folderPathToFolder = new Map<string, Folder>();
  for (const folder of workspaceFolders) {
    const path = folderPathById.get(folder.id);
    if (path != null && path !== "") folderPathToFolder.set(path, folder);
  }
  const existingRequestIdsByKey = new Map(
    workspaceRequests.map((request) => [endpointKeyForRequest(request.method, request.url), request.id]),
  );
  for (const entry of added) {
    const folderId = entry.folderPath
      ? await ensureFolderPath(ctx, workspaceId, entry.folderPath, folderPathToFolder)
      : null;
    await ctx.httpRequest.create(buildCreateRequest(entry.request, workspaceId, folderId));
  }

  for (const entry of deleted) {
    const requestId = existingRequestIdsByKey.get(entry.key);
    if (requestId != null) {
      await ctx.httpRequest.delete({ id: requestId });
    }
  }

  const requestUpdates = new Map<
    string,
    { add: HttpUrlParameter[]; remove: HttpUrlParameter[] }
  >();
  for (const entry of paramAdditions) {
    const current = requestUpdates.get(entry.requestId) ?? { add: [], remove: [] };
    current.add.push(...entry.params);
    requestUpdates.set(entry.requestId, current);
  }
  for (const entry of paramDeletions) {
    const current = requestUpdates.get(entry.requestId) ?? { add: [], remove: [] };
    current.remove.push(...entry.params);
    requestUpdates.set(entry.requestId, current);
  }

  for (const [requestId, update] of requestUpdates.entries()) {
    const existingRequest = workspaceRequests.find((request) => request.id === requestId);
    if (existingRequest == null) continue;
    const removeKeys = new Set(update.remove.map(parameterKey));
    const nextParams = (existingRequest.urlParameters ?? []).filter(
      (param) => !removeKeys.has(parameterKey(param)),
    );
    await ctx.httpRequest.update({
      id: existingRequest.id,
      workspaceId: existingRequest.workspaceId,
      folderId: existingRequest.folderId,
      authentication: existingRequest.authentication,
      authenticationType: existingRequest.authenticationType,
      body: existingRequest.body,
      bodyType: existingRequest.bodyType,
      description: existingRequest.description,
      headers: existingRequest.headers,
      method: existingRequest.method,
      name: existingRequest.name,
      sortPriority: existingRequest.sortPriority,
      url: existingRequest.url,
      urlParameters: [...nextParams, ...update.add],
    });
  }

  return {
    added: added.length,
    deleted: deleted.length,
    paramAdditions: paramAdditions.length,
    paramDeletions: paramDeletions.length,
  };
}

function getMissingParams(
  existingParams: HttpUrlParameter[],
  importedParams: HttpUrlParameter[],
): HttpUrlParameter[] {
  const normalizedExisting = existingParams.filter(isMeaningfulParameter);
  const normalizedImported = importedParams.filter(isMeaningfulParameter);
  const existingKeys = new Set(normalizedExisting.map(parameterKey));
  return normalizedImported.filter((param) => !existingKeys.has(parameterKey(param)));
}

function getExtraParams(
  existingParams: HttpUrlParameter[],
  importedParams: HttpUrlParameter[],
): HttpUrlParameter[] {
  const normalizedExisting = existingParams.filter(isMeaningfulParameter);
  const normalizedImported = importedParams.filter(isMeaningfulParameter);
  const importedKeys = new Set(normalizedImported.map(parameterKey));
  return normalizedExisting.filter((param) => !importedKeys.has(parameterKey(param)));
}

function formatParameterList(params: HttpUrlParameter[]): string {
  return params.filter(isMeaningfulParameter).map((param) => param.name).join(", ");
}

function isMeaningfulParameter(param: HttpUrlParameter): boolean {
  return param.name.trim() !== "";
}

function parameterKey(param: HttpUrlParameter): string {
  const name = param.name.startsWith(":") ? param.name.slice(1) : param.name;
  const location = param.name.startsWith(":") ? "path" : "query";
  return `${location}:${name}`;
}

function buildCreateRequest(
  request: RequestResource,
  workspaceId: string,
  folderId: string | null,
): Omit<Partial<HttpRequest>, "id" | "model" | "createdAt" | "updatedAt"> &
  Pick<HttpRequest, "workspaceId" | "url"> {
  return {
    workspaceId,
    folderId,
    url: request.url ?? "",
    name: request.name ?? "",
    description: request.description ?? "",
    method: request.method ?? "GET",
    headers: request.headers ?? [],
    body: request.body ?? {},
    bodyType: request.bodyType ?? null,
    urlParameters: request.urlParameters ?? [],
    authentication: request.authentication ?? {},
    authenticationType: request.authenticationType ?? null,
    sortPriority: request.sortPriority ?? 0,
  };
}

async function ensureFolderPath(
  ctx: Context,
  workspaceId: string,
  folderPath: string,
  folderPathToFolder: Map<string, Folder>,
): Promise<string> {
  const segments = folderPath.split("/").filter(Boolean);
  let currentPath = "";
  let parentId: string | null = null;

  for (const segment of segments) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    const existing = folderPathToFolder.get(currentPath);
    if (existing != null) {
      parentId = existing.id;
      continue;
    }

    const created = await ctx.folder.create({
      workspaceId,
      folderId: parentId,
      name: segment,
    });
    folderPathToFolder.set(currentPath, created);
    parentId = created.id;
  }

  return parentId ?? "";
}
