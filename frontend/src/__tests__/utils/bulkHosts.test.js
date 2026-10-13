import { beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardAPI } from "../../utils/api";
import {
	fetchAllMatchingHosts,
	fetchSelectedHosts,
} from "../../utils/bulkHosts";

vi.mock("../../utils/api", () => ({ dashboardAPI: { getHosts: vi.fn() } }));

beforeEach(() => vi.resetAllMocks());

describe("bulk host retrieval", () => {
	it("fetches every page with the same filters, not just the visible page", async () => {
		dashboardAPI.getHosts
			.mockResolvedValueOnce({ data: { items: [{ id: "h1" }], total: 2 } })
			.mockResolvedValueOnce({ data: { items: [{ id: "h2" }], total: 2 } });
		expect(
			await fetchAllMatchingHosts({ search: "web", group: "g1", offset: 50 }),
		).toEqual([{ id: "h1" }, { id: "h2" }]);
		expect(dashboardAPI.getHosts.mock.calls.map(([params]) => params)).toEqual([
			{ search: "web", group: "g1", limit: 500, offset: 0 },
			{ search: "web", group: "g1", limit: 500, offset: 1 },
		]);
	});

	it.each([
		{ items: [], total: 2 },
		{ items: [{ id: "h1" }], total: 2 },
		{ items: [{ id: "h2" }], total: 3 },
	])("rejects incomplete, duplicate or changing pages: %j", async (secondPage) => {
		dashboardAPI.getHosts
			.mockResolvedValueOnce({ data: { items: [{ id: "h1" }], total: 2 } })
			.mockResolvedValueOnce({ data: secondPage });
		await expect(fetchAllMatchingHosts()).rejects.toThrow(/host list changed/);
	});

	it("propagates fetch errors instead of returning a partial selection", async () => {
		dashboardAPI.getHosts
			.mockResolvedValueOnce({ data: { items: [{ id: "h1" }], total: 2 } })
			.mockRejectedValueOnce(new Error("Network unavailable"));
		await expect(fetchAllMatchingHosts()).rejects.toThrow(
			"Network unavailable",
		);
	});

	it("handles an empty fleet", async () => {
		dashboardAPI.getHosts.mockResolvedValue({ data: { items: [], total: 0 } });
		expect(await fetchAllMatchingHosts()).toEqual([]);
	});

	it("resolves selections in bounded batches, independent of the current filters", async () => {
		const ids = Array.from({ length: 205 }, (_, i) => `h${i}`);
		dashboardAPI.getHosts.mockImplementation(async ({ selected }) => {
			const items = selected
				.split(",")
				.reverse()
				.map((id) => ({ id }));
			return { data: { items, total: items.length } };
		});
		expect(await fetchSelectedHosts([...ids, ids[0]])).toEqual(
			ids.map((id) => ({ id })),
		);
		expect(dashboardAPI.getHosts).toHaveBeenCalledTimes(2);
		expect(
			dashboardAPI.getHosts.mock.calls[0][0].selected.split(","),
		).toHaveLength(200);
		expect(
			dashboardAPI.getHosts.mock.calls[1][0].selected.split(","),
		).toHaveLength(5);
	});

	it("refuses to patch a silently reduced selection when a host disappears", async () => {
		dashboardAPI.getHosts.mockResolvedValue({
			data: { items: [{ id: "h1" }], total: 1 },
		});
		await expect(fetchSelectedHosts(["h1", "h2"])).rejects.toThrow(
			/no longer available/,
		);
	});
});
