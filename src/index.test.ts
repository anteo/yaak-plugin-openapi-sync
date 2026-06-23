import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { convertOpenApi } from "./index";
import {
  diffWorkspaceEndpoints,
  endpointKeyForRequest,
  normalizeUrlPath,
  plugin,
} from "./index";

describe("openapi sync plugin", () => {
  test("exports workspace action plugin", () => {
    expect(plugin.workspaceActions).toHaveLength(1);
    expect(plugin.workspaceActions?.[0]?.label).toBe("Sync with OpenAPI...");
  });

  test("normalizes endpoint paths for diffing", () => {
    expect(normalizeUrlPath("https://api.example.com/pets/?limit=10")).toBe("/pets");
    expect(normalizeUrlPath("pets//{petId}#fragment")).toBe("/pets/{petId}");
    expect(endpointKeyForRequest("get", "https://api.example.com/pets/")).toBe("GET /pets");
  });

  test("classifies added and deleted endpoints", () => {
    const diff = diffWorkspaceEndpoints({
      workspaceId: "wk_1",
      existingFolders: [
        {
          model: "folder",
          id: "fld_existing",
          createdAt: "",
          updatedAt: "",
          workspaceId: "wk_1",
          folderId: null,
          authentication: {},
          authenticationType: null,
          description: "",
          headers: [],
          name: "Pets",
          sortPriority: 0,
        },
      ],
      existingRequests: [
        {
          model: "http_request",
          id: "req_keep",
          createdAt: "",
          updatedAt: "",
          workspaceId: "wk_1",
          folderId: "fld_existing",
          authentication: {},
          authenticationType: null,
          body: {},
          bodyType: null,
          description: "",
          headers: [],
          method: "GET",
          name: "List pets",
          sortPriority: 0,
          url: "https://api.example.com/pets",
          urlParameters: [],
        },
        {
          model: "http_request",
          id: "req_delete",
          createdAt: "",
          updatedAt: "",
          workspaceId: "wk_1",
          folderId: null,
          authentication: {},
          authenticationType: null,
          body: {},
          bodyType: null,
          description: "",
          headers: [],
          method: "DELETE",
          name: "Delete pet",
          sortPriority: 0,
          url: "https://api.example.com/pets/{petId}",
          urlParameters: [],
        },
      ],
      importedFolders: [
        {
          model: "folder",
          id: "import_folder",
          name: "Pets",
          workspaceId: "GENERATE_ID::workspace",
          folderId: null,
        },
      ],
      importedRequests: [
        {
          model: "http_request",
          id: "import_keep",
          workspaceId: "GENERATE_ID::workspace",
          folderId: "import_folder",
          name: "List pets",
          method: "GET",
          url: "https://service.example.com/pets",
        },
        {
          model: "http_request",
          id: "import_add",
          workspaceId: "GENERATE_ID::workspace",
          folderId: "import_folder",
          name: "Create pet",
          method: "POST",
          url: "https://service.example.com/pets",
        },
      ],
    });

    expect(diff.added.map((entry) => entry.key)).toEqual(["POST /pets"]);
    expect(diff.deleted.map((entry) => entry.key)).toEqual(["DELETE /pets/{petId}"]);
  });

  test("round trips OpenAPI fixture and exposes filtered requests", async () => {
    const fixturePath = path.join(
      __dirname,
      "../../yaak/plugins/importer-openapi/tests/fixtures/petstore.yaml",
    );
    const contents = fs.readFileSync(fixturePath, "utf8");
    const imported = await convertOpenApi(contents);

    expect(imported?.resources.httpRequests.length).toBe(19);
    expect(imported?.resources.folders.length).toBe(7);

    const diff = diffWorkspaceEndpoints({
      workspaceId: "wk_test",
      existingRequests: [],
      existingFolders: [],
      importedRequests: imported?.resources.httpRequests ?? [],
      importedFolders: imported?.resources.folders ?? [],
    });

    expect(diff.added.length).toBe(19);
    expect(diff.deleted.length).toBe(0);
  });
});
