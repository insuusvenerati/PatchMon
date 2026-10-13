import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Hosts from "../../pages/Hosts";
import { dashboardAPI, userPreferencesAPI } from "../../utils/api";

const { patchWizard, canManagePatching, hasModule } = vi.hoisted(() => ({
	patchWizard: vi.fn(() => null),
	canManagePatching: vi.fn(() => true),
	hasModule: vi.fn(() => true),
}));

vi.mock("../../components/PatchWizard", () => ({ default: patchWizard }));
vi.mock("../../contexts/AuthContext", () => ({
	useAuth: () => ({ canManagePatching, hasModule }),
}));

vi.mock("../../utils/api", async (importOriginal) => {
	const actual = await importOriginal();
	const ok = (data) => vi.fn(() => Promise.resolve({ data }));
	return {
		...actual,
		dashboardAPI: {
			getHosts: ok({
				items: [
					{
						id: "h1",
						api_id: "a1",
						hostname: "web-01",
						friendly_name: "web-01",
						os_type: "Ubuntu",
						os_version: "22.04",
						status: "active",
						host_group_memberships: [],
						updatesCount: 0,
						securityUpdatesCount: 0,
						last_update: new Date().toISOString(),
					},
				],
				total: 500,
				limit: 50,
				offset: 0,
			}),
			getHostFilterOptions: ok({
				osDistribution: [
					{ os_type: "Ubuntu", os_version: "22.04" },
					{ os_type: "Ubuntu", os_version: "24.04" },
				],
			}),
			getHostCounts: ok({ total: 500 }),
			getWsStatusSummary: ok({}),
		},
		hostGroupsAPI: {
			list: ok([
				{ id: "g1", name: "Web" },
				{ id: "g2", name: "DB" },
			]),
		},
		settingsAPI: { getPublic: ok({}), get: ok({}), update: ok({}) },
		userPreferencesAPI: { get: ok({}), update: ok({}) },
		alertsAPI: { getAlertConfigByType: ok({ data: {} }) },
		adminHostsAPI: {},
	};
});

let location;
let navigate;
const Probe = () => {
	location = useLocation();
	navigate = useNavigate();
	return null;
};

const renderAt = (entry) => {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<MemoryRouter initialEntries={[entry]}>
				<Hosts />
				<Probe />
			</MemoryRouter>
		</QueryClientProvider>,
	);
};

const params = () => new URLSearchParams(location.search);
const lastHostsQuery = () => dashboardAPI.getHosts.mock.calls.at(-1)[0];
const openFilters = async () => {
	await screen.findByText("Total Hosts");
	if (!screen.queryByLabelText("Reporting")) {
		fireEvent.click(screen.getByRole("button", { name: /filters/i }));
	}
};

beforeEach(() => {
	dashboardAPI.getHosts.mockClear();
	patchWizard.mockClear();
	canManagePatching.mockReturnValue(true);
	hasModule.mockReturnValue(true);
	localStorage.clear();
	vi.stubGlobal(
		"fetch",
		vi.fn(() =>
			Promise.resolve({ ok: true, json: () => Promise.resolve({ data: {} }) }),
		),
	);
});

describe("bulk host package updates", () => {
	const clickBulkText = async (text) => {
		const button = await screen.findByText(text);
		await act(async () => fireEvent.click(button));
	};
	const fleet = Array.from({ length: 26 }, (_, i) => ({
		id: `host-${i}`,
		api_id: `agent-${i}`,
		friendly_name: `web-${i}`,
		hostname: `web-${i}.local`,
		os_type: i === 25 ? "Windows" : "Ubuntu",
		status: "active",
		host_group_memberships: [],
		last_update: new Date().toISOString(),
	}));
	let originalImplementation;
	let originalPreferences;
	beforeEach(() => {
		originalImplementation = dashboardAPI.getHosts.getMockImplementation();
		originalPreferences = userPreferencesAPI.get.getMockImplementation();
		// Keep these interaction tests focused on selection, not dozens of
		// unrelated editable cells and their own queries on every host row.
		userPreferencesAPI.get.mockResolvedValue({
			data: {
				hosts_column_config: [
					"select",
					"host",
					"hostname",
					"ip",
					"group",
					"os",
					"os_version",
					"agent_version",
					"auto_update",
					"ws_status",
					"integrations",
					"status",
					"needs_reboot",
					"uptime",
					"updates",
					"security_updates",
					"ssg_version",
					"notes",
					"last_update",
					"actions",
				].map((id, order) => ({
					id,
					order,
					visible: ["select", "host", "hostname"].includes(id),
				})),
			},
		});
		dashboardAPI.getHosts.mockImplementation(async (params) => {
			const matching =
				params.filter === "selected"
					? fleet.filter((host) => params.selected.split(",").includes(host.id))
					: fleet;
			return {
				data: {
					items: matching.slice(params.offset, params.offset + params.limit),
					total: matching.length,
					limit: params.limit,
					offset: params.offset,
				},
			};
		});
	});
	afterEach(() => {
		dashboardAPI.getHosts.mockImplementation(originalImplementation);
		userPreferencesAPI.get.mockImplementation(originalPreferences);
	});

	it("selects every matching host, including hosts beyond the visible page", async () => {
		renderAt("/hosts?pageSize=25&search=web&group=g1");
		await clickBulkText("Select all matching hosts");
		await screen.findByText("26 hosts selected");
		expect(dashboardAPI.getHosts).toHaveBeenCalledWith(
			expect.objectContaining({
				search: "web",
				group: "g1",
				limit: 500,
				offset: 0,
			}),
		);
	});

	it("preserves selections across pages and locks the wizard to all selected supported hosts", async () => {
		renderAt("/hosts?pageSize=25");
		await clickBulkText("Select page");
		await screen.findByText("25 hosts selected");
		await act(async () =>
			fireEvent.click(screen.getByLabelText("Next hosts page")),
		);
		await waitFor(() => expect(lastHostsQuery().offset).toBe(25));
		await act(async () => fireEvent.click(screen.getByText("Update Packages")));
		await waitFor(() => expect(patchWizard).toHaveBeenCalled());
		expect(patchWizard.mock.calls.at(-1)[0]).toMatchObject({
			isOpen: true,
			mode: "trigger",
			patchType: "patch_all",
			lockHosts: true,
			presetHosts: fleet.slice(0, 25),
		});
	});

	it("explicitly skips Windows and removes only successfully submitted hosts", async () => {
		renderAt("/hosts?pageSize=25");
		await clickBulkText("Select all matching hosts");
		await screen.findByText("26 hosts selected");
		await act(async () => fireEvent.click(screen.getByText("Update Packages")));
		await screen.findByText(/Skipped 1 Windows host/);
		await waitFor(() => expect(patchWizard).toHaveBeenCalled());
		const props = patchWizard.mock.calls.at(-1)[0];
		expect(props.presetHosts).toHaveLength(25);
		await act(async () => {
			props.onSuccess("approval", {
				runs: [{ hostId: "host-0", runId: "run-0" }],
				deferred: true,
			});
			props.onClose();
		});
		await screen.findByText("25 hosts selected");
		expect(
			screen.getByText(/1 host submitted for approval/),
		).toBeInTheDocument();
		expect(
			screen.getByText("View update queue", { selector: "a" }),
		).toHaveAttribute("href", "/patching?tab=runs");
		expect(location.pathname).toBe("/hosts");
	});

	it("respects live connection filters when selecting across all pages", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({
					data: Object.fromEntries(
						fleet.map((host, i) => [host.api_id, { connected: i === 0 }]),
					),
				}),
			})),
		);
		renderAt("/hosts?connection=connected");
		await clickBulkText("Select all matching hosts");
		await screen.findByText("1 host selected");
		await act(async () => fireEvent.click(screen.getByText("Update Packages")));
		await waitFor(() => expect(patchWizard).toHaveBeenCalled());
		expect(patchWizard.mock.calls.at(-1)[0].presetHosts).toEqual([fleet[0]]);
	});

	it("does not open a wizard if selected-host retrieval fails", async () => {
		renderAt("/hosts?pageSize=25");
		await clickBulkText("Select page");
		await screen.findByText("25 hosts selected");
		dashboardAPI.getHosts.mockRejectedValueOnce(new Error("Connection lost"));
		await act(async () => fireEvent.click(screen.getByText("Update Packages")));
		await screen.findByText("Connection lost");
		expect(patchWizard).not.toHaveBeenCalled();
		expect(screen.getByText("25 hosts selected")).toBeInTheDocument();
	});

	it("discards an in-flight select-all when the selection is cleared", async () => {
		renderAt("/hosts?pageSize=25");
		await clickBulkText("Select page");
		await screen.findByText("25 hosts selected");
		let resolve;
		dashboardAPI.getHosts.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		await act(async () =>
			fireEvent.click(screen.getByText("Select all matching hosts")),
		);
		await act(async () => fireEvent.click(screen.getByText("Clear Selection")));
		await act(async () =>
			resolve({ data: { items: fleet, total: fleet.length } }),
		);
		expect(screen.queryByText("26 hosts selected")).not.toBeInTheDocument();
		expect(screen.queryByText("Update Packages")).not.toBeInTheDocument();
	});

	it("discards an in-flight select-all when the filter changes", async () => {
		renderAt("/hosts?pageSize=25");
		await screen.findByText("Select all matching hosts");
		let resolve;
		dashboardAPI.getHosts.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		await clickBulkText("Select all matching hosts");
		await act(async () => navigate("/hosts?search=database"));
		await act(async () =>
			resolve({ data: { items: fleet, total: fleet.length } }),
		);
		expect(screen.queryByText("26 hosts selected")).not.toBeInTheDocument();
		expect(patchWizard).not.toHaveBeenCalled();
	});

	it("does not open an empty wizard when only Windows hosts are selected", async () => {
		renderAt("/hosts?filter=selected&selected=host-25");
		await clickBulkText("Update Packages");
		await screen.findByText(/Skipped 1 Windows host/);
		expect(patchWizard).not.toHaveBeenCalled();
		expect(screen.getByText("1 host selected")).toBeInTheDocument();
	});

	it.each([
		"permission",
		"module",
	])("hides package updates without the required %s", async (restriction) => {
		if (restriction === "permission") canManagePatching.mockReturnValue(false);
		else hasModule.mockReturnValue(false);
		renderAt("/hosts?pageSize=25");
		await clickBulkText("Select page");
		await screen.findByText("25 hosts selected");
		expect(screen.queryByText("Update Packages")).not.toBeInTheDocument();
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("Hosts filters are written to the URL", () => {
	it("writes each dropdown filter to the URL and drops it again at its default", async () => {
		renderAt("/hosts");
		await openFilters();

		fireEvent.change(screen.getByLabelText("Reporting"), {
			target: { value: "overdue" },
		});
		fireEvent.change(screen.getByLabelText("Connection"), {
			target: { value: "offline" },
		});
		fireEvent.change(screen.getByLabelText("Host Group"), {
			target: { value: "g2" },
		});
		await screen.findByRole("option", { name: "Ubuntu" });
		fireEvent.change(screen.getByLabelText("Operating System"), {
			target: { value: "ubuntu" },
		});
		fireEvent.change(await screen.findByLabelText("OS Version"), {
			target: { value: "24.04" },
		});

		expect(params().get("status")).toBe("overdue");
		expect(params().get("connection")).toBe("offline");
		expect(params().get("group")).toBe("g2");
		expect(params().get("osFilter")).toBe("ubuntu");
		expect(params().get("osVersionFilter")).toBe("24.04");

		fireEvent.change(screen.getByLabelText("Reporting"), {
			target: { value: "all" },
		});
		fireEvent.change(screen.getByLabelText("Operating System"), {
			target: { value: "all" },
		});
		expect(params().has("status")).toBe(false);
		expect(params().has("osFilter")).toBe(false);
		expect(params().has("osVersionFilter")).toBe(false);
		expect(params().get("connection")).toBe("offline");
	});

	it("writes grouping, hide stale and sort, and leaves defaults out", async () => {
		renderAt("/hosts");
		await screen.findByText("Total Hosts");
		expect(location.search).toBe("");

		fireEvent.change(screen.getByDisplayValue("No Grouping"), {
			target: { value: "os" },
		});
		fireEvent.click(screen.getByRole("button", { name: /hide stale/i }));
		expect(params().get("groupBy")).toBe("os");
		expect(params().get("hideStale")).toBe("true");

		fireEvent.click(
			screen.getAllByRole("button", { name: /system hostname/i })[0],
		);
		expect(params().get("order")).toBe("desc");
		expect(params().has("sort")).toBe(false);
		fireEvent.click(
			screen.getAllByRole("button", { name: /system hostname/i })[0],
		);
		expect(params().has("order")).toBe(false);
	});

	it("writes the search term after the debounce", async () => {
		renderAt("/hosts");
		await screen.findByText("Total Hosts");
		vi.useFakeTimers();
		fireEvent.change(screen.getByPlaceholderText(/search hosts/i), {
			target: { value: "web-01 " },
		});
		expect(params().has("search")).toBe(false);
		act(() => vi.advanceTimersByTime(400));
		expect(params().get("search")).toBe("web-01");
		fireEvent.change(screen.getByPlaceholderText(/search hosts/i), {
			target: { value: "" },
		});
		act(() => vi.advanceTimersByTime(400));
		expect(params().has("search")).toBe(false);
	});

	it("goes back to page 1 when a filter changes", async () => {
		renderAt("/hosts?page=3");
		await openFilters();
		expect(params().get("page")).toBe("3");
		fireEvent.change(screen.getByLabelText("Connection"), {
			target: { value: "connected" },
		});
		expect(params().get("page")).not.toBe("3");
	});
});

describe("Hosts filters are restored from the URL", () => {
	it("restores every filter, the search and the sort on load", async () => {
		renderAt(
			"/hosts?status=overdue&connection=offline&group=g2&osFilter=ubuntu&osVersionFilter=22.04&search=web&groupBy=os&hideStale=true&sort=ip&order=desc",
		);
		await openFilters();
		await screen.findByRole("option", { name: "DB" });
		expect(screen.getByLabelText("Reporting")).toHaveValue("overdue");
		expect(screen.getByLabelText("Connection")).toHaveValue("offline");
		expect(screen.getByLabelText("Host Group")).toHaveValue("g2");
		expect(screen.getByLabelText("Operating System")).toHaveValue("ubuntu");
		expect(screen.getByLabelText("OS Version")).toHaveValue("22.04");
		expect(screen.getByPlaceholderText(/search hosts/i)).toHaveValue("web");
		expect(screen.getByDisplayValue("By OS")).toBeInTheDocument();

		await waitFor(() =>
			expect(lastHostsQuery()).toMatchObject({
				search: "web",
				group: "g2",
				os: "ubuntu",
				osVersion: "22.04",
				hideStale: "true",
				sort: "ip",
				order: "desc",
			}),
		);
	});

	it("follows back and forward navigation", async () => {
		renderAt("/hosts");
		await openFilters();
		act(() => navigate("/hosts?status=stale&search=db"));
		expect(screen.getByLabelText("Reporting")).toHaveValue("stale");
		expect(screen.getByPlaceholderText(/search hosts/i)).toHaveValue("db");
		act(() => navigate(-1));
		expect(screen.getByLabelText("Reporting")).toHaveValue("all");
		expect(screen.getByPlaceholderText(/search hosts/i)).toHaveValue("");
	});

	it("ignores values that are not valid options", async () => {
		renderAt(
			"/hosts?status=bogus&connection=nope&groupBy=x&sort=evil&order=up",
		);
		await openFilters();
		expect(screen.getByLabelText("Reporting")).toHaveValue("all");
		expect(screen.getByLabelText("Connection")).toHaveValue("all");
		expect(screen.getByDisplayValue("No Grouping")).toBeInTheDocument();
		await waitFor(() =>
			expect(lastHostsQuery()).toMatchObject({
				sort: "hostname",
				order: "asc",
			}),
		);
	});
});

describe("existing deep links into /hosts still apply", () => {
	it.each([
		["/hosts?filter=stale", "stale"],
		["/hosts?filter=upToDate", "reporting"],
		["/hosts?filter=needsUpdates", "all"],
		["/hosts?filter=inactive", "all"],
	])("%s opens the filters with Reporting = %s", async (entry, status) => {
		renderAt(entry);
		await screen.findByText("Total Hosts");
		expect(screen.getByLabelText("Reporting")).toHaveValue(status);
		await waitFor(() =>
			expect(lastHostsQuery().filter).toBe(
				new URLSearchParams(entry.split("?")[1]).get("filter"),
			),
		);
	});

	it("rewrites the legacy offline link to stale", async () => {
		renderAt("/hosts?filter=offline");
		await screen.findByText("Total Hosts");
		await waitFor(() => expect(params().get("filter")).toBe("stale"));
		expect(screen.getByLabelText("Reporting")).toHaveValue("stale");
	});

	it("applies the dashboard OS chart link", async () => {
		renderAt("/hosts?osFilter=ubuntu&osVersionFilter=22.04&showFilters=true");
		await screen.findByText("Total Hosts");
		expect(screen.getByLabelText("Operating System")).toHaveValue("ubuntu");
		expect(screen.getByLabelText("OS Version")).toHaveValue("22.04");
		await waitFor(() =>
			expect(lastHostsQuery()).toMatchObject({
				os: "ubuntu",
				osVersion: "22.04",
			}),
		);
	});

	it("applies the host group link from settings", async () => {
		renderAt("/hosts?group=g1");
		await screen.findByRole("option", { name: "Web" });
		expect(screen.getByLabelText("Host Group")).toHaveValue("g1");
		await waitFor(() => expect(lastHostsQuery().group).toBe("g1"));
	});

	it("applies the reboot and selected-hosts links", async () => {
		renderAt("/hosts?reboot=true");
		await screen.findByText("Total Hosts");
		await waitFor(() => expect(lastHostsQuery().reboot).toBe("true"));
	});

	it("applies the packages page selected-hosts link", async () => {
		renderAt("/hosts?selected=a,b&filter=selected");
		await screen.findByText("Total Hosts");
		await waitFor(() =>
			expect(lastHostsQuery()).toMatchObject({
				filter: "selected",
				selected: "a,b",
			}),
		);
	});

	it("a later filter change keeps the deep link and does not re-impose it", async () => {
		renderAt("/hosts?filter=stale");
		await screen.findByText("Total Hosts");
		fireEvent.change(screen.getByLabelText("Reporting"), {
			target: { value: "overdue" },
		});
		expect(screen.getByLabelText("Reporting")).toHaveValue("overdue");
		expect(params().get("filter")).toBe("stale");
		expect(params().get("status")).toBe("overdue");
	});

	it("clicking a stat card replaces the URL filters", async () => {
		renderAt("/hosts?status=overdue&search=web&groupBy=os");
		await screen.findByText("Total Hosts");
		fireEvent.click(screen.getByText("Needs Updates"));
		expect(params().get("filter")).toBe("needsUpdates");
		expect(params().has("status")).toBe(false);
		fireEvent.click(screen.getByText("Total Hosts"));
		expect(location.search).toBe("");
		expect(screen.getByPlaceholderText(/search hosts/i)).toHaveValue("");
	});
});
