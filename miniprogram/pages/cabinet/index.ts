import { medicationDisplayGroup } from "../../core/medication-copy";
import { getSaveQueue } from "../../services/save-queue";
import { saveJobView } from "../../services/save-job-view";
import { getInventorySession } from "../../services/inventory-session";
import {
  dateKeyFromMs,
  formatChineseDate,
  formatDose,
  formatShortChineseDate,
} from "../../core/dates";
import { evaluateCabinetMedication } from "../../core/cabinet";
import { resolveExpiry } from "../../core/expiry";
import type { AppState, Medication } from "../../core/models";
import { showError } from "../../services/ui";

interface MedicineCard {
  id: string;
  name: string;
  specification: string;
  expiryFilter: string;
  photoUrl: string;
  profileName: string;
  profileId: string;
  estimateText: string;
  depletionText: string;
  expiryText: string;
  expiryBasisText: string;
  nextText: string;
  status: string;
  statusClass: string;
  sortRank: number;
  updatedAt: string;
  searchText: string;
  storageLocation: string;
  syncText: string;
  groupKey: string;
  expiryDate: string;
  groupHeading?: string;
  groupHidden?: boolean;
}

interface ArchivedCard {
  specification: string;
  id: string;
  name: string;
  profileName: string;
  expiryText: string;
  version: number;
}

const medicationCard = (
  state: AppState,
  medication: Medication,
  nowMs: number,
): MedicineCard => {
  const profile = state.profiles.find(
    (item) => item.id === medication.profileId,
  );
  const facts = evaluateCabinetMedication({ state, medication, nowMs });
  const { estimate, expiry } = facts;
  const expiryDate = expiry.effectiveExpiryDate;
  const days = facts.daysToExpiry;
  const expiryFilter =
    days < 0
      ? "expired"
      : days <= state.settings.expiryLeadDays
        ? "expiring"
        : "later";
  const statusCopy = {
    text:
      days < 0
        ? `已超过记录期限 ${-days} 天`
        : days === 0
          ? "今天到期"
          : `距到期 ${days} 天`,
    className:
      days < 0 ? "danger" : expiryFilter === "expiring" ? "warning" : "normal",
  };

  let estimateText = "数量未记录";
  if (estimate.currentQuantityMilli !== null) {
    estimateText = `预计剩余 ${formatDose(estimate.currentQuantityMilli, medication.unit)}`;
  }
  let depletionText = "记录数量后可估算用完时间";
  if (estimate.reason === "as-needed")
    depletionText = "按需使用，无法预测用完时间";
  else if (estimate.reason === "no-plan")
    depletionText = "没有固定计划，无法预测用完时间";
  else if (estimate.firstShortageAt) {
    depletionText = `预计 ${formatShortChineseDate(dateKeyFromMs(Date.parse(estimate.firstShortageAt)))} 起不足`;
  } else if (estimate.lastCoveredAt) {
    depletionText = `计划结束时仍有预计余量`;
  }

  return {
    id: medication.id,
    storageLocation: medication.storageLocation ?? "",
    syncText: "",
    groupKey: medicationDisplayGroup(medication),
    expiryDate,
    name: medication.name,
    specification: medication.specification || "未填写规格",
    expiryFilter,
    photoUrl:
      medication.photo?.thumbnailUrl ??
      medication.photo?.url ??
      medication.photo?.fileId ??
      "",
    profileName: profile?.name ?? "成员",
    profileId: medication.profileId,
    estimateText,
    depletionText:
      medication.mode === "scheduled"
        ? `按计划估算 · ${depletionText}`
        : depletionText,
    expiryText:
      expiry.source === "after-open"
        ? formatChineseDate(expiryDate)
        : formatChineseDate(medication.expiryValue, medication.expiryPrecision),
    expiryBasisText:
      expiry.source === "after-open"
        ? `按开封后期限管理 · 包装至${formatChineseDate(medication.expiryValue, medication.expiryPrecision)}`
        : medication.expiryPrecision === "month"
          ? `按${formatShortChineseDate(expiryDate)}管理`
          : "按包装完整日期管理",
    nextText: facts.nextOccurrence
      ? `下次 ${facts.nextOccurrence.time}`
      : "没有固定计划",
    status: statusCopy.text,
    statusClass: statusCopy.className,
    sortRank: facts.sortRank,
    updatedAt: medication.updatedAt,
    searchText: [
      medication.name,
      medication.specification,
      medication.note,
      medication.storageLocation ?? "",
      profile?.name ?? "",
    ]
      .join(" ")
      .toLocaleLowerCase(),
  };
};

Page({
  data: {
    loading: true,
    locationOptions: ["全部位置"],
    locationIndex: 0,
    groupBoxes: false,
    collapsedGroups: {} as Record<string, boolean>,
    error: "",
    query: "",
    selectedProfileId: "all",
    selectedExpiry: "all",
    expiryCounts: { all: 0, expiring: 0, expired: 0 },
    archivedExpanded: false,
    profiles: [] as Array<{ id: string; name: string }>,
    allCards: [] as MedicineCard[],
    cards: [] as MedicineCard[],
    archivedCards: [] as ArchivedCard[],
    busyArchivedId: "",
  },

  async onShow() {
    this.getTabBar?.()?.setData({ selected: 1 });
    await this.loadData();
  },

  async onPullDownRefresh() {
    await this.loadData();
    void wx.stopPullDownRefresh();
  },

  async loadData() {
    this.setData({ loading: true, error: "" });
    try {
      const state = await getApp<IAppOption>().getService().bootstrap();
      if (!state.settings.privacyAcceptedVersion) {
        await wx.reLaunch({ url: "/pages/start/index" });
        return;
      }
      const nowMs = Date.now();
      const jobs = getSaveQueue(getApp<IAppOption>().getService()).list();
      const cards = state.medications
        .filter((item) => !item.archivedAt)
        .map((item) => {
          const card = medicationCard(state, item, nowMs);
          const job = jobs.find(
            (job) =>
              job.status !== "ready" &&
              (job.medicationId === item.id || job.draft.id === item.id),
          );
          return { ...card, syncText: job ? saveJobView(job).message : "" };
        })
        .sort(
          (a, b) =>
            a.sortRank - b.sortRank || b.updatedAt.localeCompare(a.updatedAt),
        );
      this.setData({
        loading: false,
        profiles: state.profiles
          .filter((item) => !item.archivedAt)
          .map(({ id, name }) => ({ id, name })),
        allCards: cards,
        locationOptions: [
          "全部位置",
          ...new Set(cards.map((card) => card.storageLocation).filter(Boolean)),
        ],
        locationIndex: 0,
        archivedCards: state.medications
          .filter((item) => Boolean(item.archivedAt))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map((medication) => ({
            id: medication.id,
            name: medication.name,
            specification: medication.specification || "未填写规格",
            profileName:
              state.profiles.find((item) => item.id === medication.profileId)
                ?.name ?? "成员",
            expiryText: formatChineseDate(
              resolveExpiry(medication).effectiveExpiryDate,
            ),
            version: medication.version,
          })),
      });
      this.applyFilters();
    } catch (error) {
      this.setData({
        loading: false,
        error: error instanceof Error ? error.message : "暂时没加载出来",
      });
    }
  },

  onSearch(event: WechatMiniprogram.Input) {
    this.setData({ query: event.detail.value });
    this.applyFilters();
  },

  clearSearch() {
    this.setData({ query: "" });
    this.applyFilters();
  },

  clearFilters() {
    this.setData({
      query: "",
      selectedProfileId: "all",
      selectedExpiry: "all",
      locationIndex: 0,
    });
    this.applyFilters();
  },

  selectProfile(event: WechatMiniprogram.BaseEvent) {
    this.setData({
      selectedProfileId: String(event.currentTarget.dataset["id"] ?? "all"),
    });
    this.applyFilters();
  },

  toggleArchived() {
    this.setData({ archivedExpanded: !this.data.archivedExpanded });
  },
  selectExpiry(event: WechatMiniprogram.BaseEvent) {
    this.setData({
      selectedExpiry: String(event.currentTarget.dataset["id"] || "all"),
    });
    this.applyFilters();
  },
  applyFilters() {
    const query = this.data.query.trim().toLocaleLowerCase();
    const cards = this.data.allCards.filter(
      (item) =>
        (this.data.selectedProfileId === "all" ||
          item.profileId === this.data.selectedProfileId) &&
        (this.data.locationIndex === 0 ||
          item.storageLocation ===
            this.data.locationOptions[this.data.locationIndex]) &&
        (!query || item.searchText.includes(query)),
    );
    this.setData({
      expiryCounts: {
        all: cards.length,
        expiring: cards.filter((item) => item.expiryFilter === "expiring")
          .length,
        expired: cards.filter((item) => item.expiryFilter === "expired").length,
      },
      cards: this.organizeCards(
        cards.filter(
          (item) =>
            this.data.selectedExpiry === "all" ||
            item.expiryFilter === this.data.selectedExpiry,
        ),
      ),
    });
  },

  organizeCards(cards: MedicineCard[]): MedicineCard[] {
    if (!this.data.groupBoxes)
      return cards.map((card) => ({
        ...card,
        groupHeading: "",
        groupHidden: false,
      }));
    const groups = new Map<string, MedicineCard[]>();
    for (const card of cards)
      groups.set(card.groupKey, [...(groups.get(card.groupKey) ?? []), card]);
    return [...groups.values()].flatMap((group) =>
      group
        .sort(
          (a, b) =>
            a.expiryDate.localeCompare(b.expiryDate) ||
            a.id.localeCompare(b.id),
        )
        .map((card, index) => ({
          ...card,
          groupHeading:
            index === 0 && group.length > 1
              ? `${card.name} · ${group.length} 盒（分别记录）`
              : "",
          groupHidden:
            group.length > 1 &&
            Boolean(this.data.collapsedGroups[card.groupKey]),
        })),
    );
  },
  changeLocation(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ locationIndex: Number(event.detail.value) });
    this.applyFilters();
  },
  toggleGrouping() {
    this.setData({ groupBoxes: !this.data.groupBoxes });
    this.applyFilters();
  },
  toggleGroup(event: WechatMiniprogram.BaseEvent) {
    const key = String(event.currentTarget.dataset["group"] ?? "");
    this.setData({
      collapsedGroups: {
        ...this.data.collapsedGroups,
        [key]: !this.data.collapsedGroups[key],
      },
    });
    this.applyFilters();
  },
  async startInventorySession() {
    try {
      const session = getInventorySession(getApp<IAppOption>().getService());
      if (!session.load())
        session.start(this.data.cards.map((card) => card.id));
      await wx.navigateTo({ url: "/pages/inventory-session/index" });
    } catch (error) {
      showError(error);
    }
  },
  openMedicine(event: WechatMiniprogram.BaseEvent) {
    void wx.navigateTo({
      url: `/pages/medicine-detail/index?id=${String(event.currentTarget.dataset["id"] ?? "")}`,
    });
  },

  onCardPhotoError(event: WechatMiniprogram.BaseEvent) {
    const id = String(event.currentTarget.dataset["id"] ?? "");
    if (!id) return;
    const clearBrokenPhoto = (item: MedicineCard): MedicineCard =>
      item.id === id ? { ...item, photoUrl: "" } : item;
    this.setData({
      allCards: this.data.allCards.map(clearBrokenPhoto),
      cards: this.data.cards.map(clearBrokenPhoto),
    });
  },

  addMedicine() {
    void wx.navigateTo({ url: "/pages/medicine-form/index" });
  },

  openSettings() {
    void wx.navigateTo({ url: "/pages/settings/index" });
  },

  async restoreArchived(event: WechatMiniprogram.BaseEvent) {
    const id = String(event.currentTarget.dataset["id"] ?? "");
    const card = this.data.archivedCards.find((item) => item.id === id);
    if (!card || this.data.busyArchivedId) return;
    const decision = await wx.showModal({
      title: "恢复这个药盒？",
      content: `${card.name}\n${card.specification} · ${card.profileName}\n记录到期：${card.expiryText}\n恢复后只继续管理有效期；原服药计划不会自动重新启用。`,
      cancelText: "取消",
      confirmText: "恢复",
      confirmColor: "#167A50",
    });
    if (!decision.confirm) return;
    this.setData({ busyArchivedId: id });
    try {
      await getApp<IAppOption>()
        .getService()
        .restoreMedication(card.id, card.version);
      await this.loadData();
      void wx.showToast({ title: "已恢复", icon: "success" });
    } catch (error) {
      showError(error, "没有恢复成功");
    } finally {
      this.setData({ busyArchivedId: "" });
    }
  },

  async deleteArchived(event: WechatMiniprogram.BaseEvent) {
    const id = String(event.currentTarget.dataset["id"] ?? "");
    const card = this.data.archivedCards.find((item) => item.id === id);
    if (!card || this.data.busyArchivedId) return;
    const decision = await wx.showModal({
      title: "永久删除这个药盒？",
      content: `${card.name}\n${card.specification} · ${card.profileName}\n记录到期：${card.expiryText}\n将同时删除计划、盘点和使用记录，无法恢复；手机系统日历中的旧事件仍需自行删除。`,
      cancelText: "取消",
      confirmText: "永久删除",
      confirmColor: "#B63D3D",
    });
    if (!decision.confirm) return;
    this.setData({ busyArchivedId: id });
    try {
      await getApp<IAppOption>()
        .getService()
        .deleteMedication(card.id, card.version);
      await this.loadData();
      void wx.showToast({ title: "已永久删除", icon: "success" });
    } catch (error) {
      showError(error, "没有删除成功");
    } finally {
      this.setData({ busyArchivedId: "" });
    }
  },

  async retry() {
    await this.loadData();
  },
});
