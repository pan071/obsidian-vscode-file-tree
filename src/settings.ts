/**
 * 插件设置页：显示、过滤、自动定位、打开行为、搜索、拖拽等配置
 *
 * @author 启年
 * @createTime 2026-10-14 13:27
 */
import { App, PluginSettingTab, Setting } from "obsidian";
import type VscodeFileTreePlugin from "./main";
import {
	AutoRevealMode,
	ClickOpenMode,
	ExtensionDisplay,
	FilterMode,
	IconSource,
	NameDisplayMode,
	OpenLocation,
	ScrollAlign,
	SearchScope,
	SortOrder,
	UnsupportedFileAction,
} from "./types";
import { AUTO_REVEAL_LABELS, SORT_LABELS } from "./view";

/**
 * 解析扩展名列表：支持逗号、空格、换行分隔，去掉开头的点并转小写
 *
 * @param value 输入文本
 * @returns 扩展名列表
 */
function parseExtensions(value: string): string[] {
	return value
		.split(/[\s,，]+/)
		.map((e) => e.trim().replace(/^\.+/, "").toLowerCase())
		.filter((e) => e.length > 0);
}

/**
 * 解析文件夹路径列表：每行一个，去掉首尾斜杠
 *
 * @param value 输入文本
 * @returns 路径列表
 */
function parseFolders(value: string): string[] {
	return value
		.split(/\n+/)
		.map((p) => p.trim().replace(/^\/+|\/+$/g, ""))
		.filter((p) => p.length > 0);
}

/**
 * 插件设置页，修改后立即保存并刷新文件树
 *
 * @author 启年
 * @createTime 2026-10-14 13:27
 */
export class FileTreeSettingTab extends PluginSettingTab {
	/** 插件实例 */
	private readonly plugin: VscodeFileTreePlugin;

	/**
	 * 创建设置页
	 *
	 * @param app Obsidian 应用实例
	 * @param plugin 插件实例
	 */
	constructor(app: App, plugin: VscodeFileTreePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * 渲染设置项
	 */
	display(): void {
		const { containerEl } = this;
		const settings = this.plugin.settings;
		const save = async (): Promise<void> => this.plugin.saveSettings();
		containerEl.empty();

		// region 显示
		new Setting(containerEl).setName("显示").setHeading();

		new Setting(containerEl)
			.setName("长文件名展示方式")
			.setDesc("自动换行：完整显示；省略号：超出部分截断，悬停显示全名；横向滚动：单行完整显示，超出宽度时出现横向滚动条。")
			.addDropdown((dd) =>
				dd
					.addOptions({
						[NameDisplayMode.Wrap]: "自动换行",
						[NameDisplayMode.Ellipsis]: "省略号截断",
						[NameDisplayMode.Scroll]: "横向滚动",
					})
					.setValue(settings.nameDisplay)
					.onChange(async (value) => {
						settings.nameDisplay = value as NameDisplayMode;
						await save();
					}),
			);

		new Setting(containerEl).setName("扩展名显示").addDropdown((dd) =>
			dd
				.addOptions({
					[ExtensionDisplay.ShowAll]: "全部显示",
					[ExtensionDisplay.HideMarkdown]: "只隐藏 .md",
					[ExtensionDisplay.HideAll]: "全部隐藏",
				})
				.setValue(settings.extensionDisplay)
				.onChange(async (value) => {
					settings.extensionDisplay = value as ExtensionDisplay;
					await save();
				}),
		);

		new Setting(containerEl)
			.setName("图标")
			.setDesc("自动：已启用 Material Icon Theme 插件时使用它的图标，否则使用内置图标。")
			.addDropdown((dd) =>
				dd
					.addOptions({
						[IconSource.Auto]: "自动",
						[IconSource.Builtin]: "内置图标",
						[IconSource.None]: "不显示",
					})
					.setValue(settings.iconSource)
					.onChange(async (value) => {
						settings.iconSource = value as IconSource;
						await save();
					}),
			);

		new Setting(containerEl).setName("排序方式").addDropdown((dd) => {
			for (const order of Object.values(SortOrder)) {
				dd.addOption(order, SORT_LABELS[order]);
			}
			dd.setValue(settings.sortOrder).onChange(async (value) => {
				settings.sortOrder = value as SortOrder;
				await save();
			});
		});

		new Setting(containerEl)
			.setName("文件夹在前")
			.setDesc("按名称排序时文件夹排在文件前面；按时间排序时文件夹始终在前。")
			.addToggle((toggle) =>
				toggle.setValue(settings.foldersFirst).onChange(async (value) => {
					settings.foldersFirst = value;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("紧凑文件夹")
			.setDesc("只有一个子文件夹的文件夹链合并成一行显示，如 a / b / c。")
			.addToggle((toggle) =>
				toggle.setValue(settings.compactFolders).onChange(async (value) => {
					settings.compactFolders = value;
					await save();
				}),
			);

		new Setting(containerEl).setName("显示根节点（库名）").addToggle((toggle) =>
			toggle.setValue(settings.showRoot).onChange(async (value) => {
				settings.showRoot = value;
				await save();
			}),
		);

		new Setting(containerEl)
			.setName("显示文件数量")
			.setDesc("文件夹右侧显示其下可见文件总数（含子文件夹）。")
			.addToggle((toggle) =>
				toggle.setValue(settings.showFileCount).onChange(async (value) => {
					settings.showFileCount = value;
					await save();
				}),
			);

		new Setting(containerEl).setName("缩进参考线").addToggle((toggle) =>
			toggle.setValue(settings.showIndentGuides).onChange(async (value) => {
				settings.showIndentGuides = value;
				await save();
			}),
		);

		new Setting(containerEl).setName("缩进宽度").addSlider((slider) =>
			slider
				.setLimits(8, 32, 2)
				.setValue(settings.indentWidth)
				.setDynamicTooltip()
				.onChange(async (value) => {
					settings.indentWidth = value;
					await save();
				}),
		);
		// endregion

		// region 过滤
		new Setting(containerEl).setName("过滤").setHeading();

		new Setting(containerEl)
			.setName("扩展名过滤模式")
			.setDesc("黑名单：隐藏列表中的扩展名；白名单：只显示列表中的扩展名。")
			.addDropdown((dd) =>
				dd
					.addOptions({
						[FilterMode.All]: "显示全部文件",
						[FilterMode.Blacklist]: "黑名单",
						[FilterMode.Whitelist]: "白名单",
					})
					.setValue(settings.filterMode)
					.onChange(async (value) => {
						settings.filterMode = value as FilterMode;
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("扩展名列表")
			.setDesc("用逗号、空格或换行分隔，不区分大小写，可带点也可不带，支持多段扩展名如 excalidraw.md。")
			.addTextArea((text) =>
				text
					.setPlaceholder("png, jpg, excalidraw.md")
					.setValue(settings.filterExtensions.join(", "))
					.onChange(async (value) => {
						settings.filterExtensions = parseExtensions(value);
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("隐藏的文件夹")
			.setDesc("每行一个库内路径，该文件夹及其子孙都不显示，如 assets 或 notes/assets。")
			.addTextArea((text) =>
				text
					.setPlaceholder("assets")
					.setValue(settings.hiddenFolders.join("\n"))
					.onChange(async (value) => {
						settings.hiddenFolders = parseFolders(value);
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("隐藏空文件夹")
			.setDesc("过滤后没有任何可见文件的文件夹不显示（白名单模式下推荐开启）。")
			.addToggle((toggle) =>
				toggle.setValue(settings.hideEmptyFolders).onChange(async (value) => {
					settings.hideEmptyFolders = value;
					await save();
				}),
			);
		// endregion

		// region 自动显示当前文件
		new Setting(containerEl).setName("自动显示当前文件").setHeading();

		new Setting(containerEl)
			.setName("模式")
			.setDesc("切换到另一个文件时如何在文件树中定位它。也可以点击或右键工具栏按钮切换。")
			.addDropdown((dd) => {
				for (const mode of Object.values(AutoRevealMode)) {
					dd.addOption(mode, AUTO_REVEAL_LABELS[mode]);
				}
				dd.setValue(settings.autoRevealMode).onChange(async (value) => {
					await this.plugin.setAutoRevealMode(value as AutoRevealMode);
				});
			});

		new Setting(containerEl)
			.setName("滚动对齐")
			.setDesc("目标行不在可见区域时滚动到哪里；已经可见时不滚动。")
			.addDropdown((dd) =>
				dd
					.addOptions({ [ScrollAlign.Nearest]: "刚好可见", [ScrollAlign.Center]: "居中" })
					.setValue(settings.scrollAlign)
					.onChange(async (value) => {
						settings.scrollAlign = value as ScrollAlign;
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("手动滚动保护时间（毫秒）")
			.setDesc("刚用滚轮或滚动条浏览过文件树的这段时间内切换文件，只高亮不滚动，避免和手上的操作抢。填 0 关闭。")
			.addText((text) =>
				text.setValue(String(settings.scrollGuardMs)).onChange(async (value) => {
					const n = Number.parseInt(value, 10);
					settings.scrollGuardMs = Number.isFinite(n) && n >= 0 ? n : 0;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("定位时折叠无关文件夹")
			.setDesc("只保留当前文件的上级文件夹处于展开状态。")
			.addToggle((toggle) =>
				toggle.setValue(settings.collapseOthersOnReveal).onChange(async (value) => {
					settings.collapseOthersOnReveal = value;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("不自动定位的文件夹")
			.setDesc("每行一个库内路径，这些文件夹下的文件只高亮、不自动展开和滚动。")
			.addTextArea((text) =>
				text.setValue(settings.revealExcludedFolders.join("\n")).onChange(async (value) => {
					settings.revealExcludedFolders = parseFolders(value);
					await save();
				}),
			);
		// endregion

		// region 打开行为
		new Setting(containerEl).setName("打开行为").setHeading();

		new Setting(containerEl).setName("打开方式").addDropdown((dd) =>
			dd
				.addOptions({ [ClickOpenMode.Single]: "单击打开", [ClickOpenMode.Double]: "双击打开（单击只选中）" })
				.setValue(settings.clickOpenMode)
				.onChange(async (value) => {
					settings.clickOpenMode = value as ClickOpenMode;
					await save();
				}),
		);

		new Setting(containerEl)
			.setName("默认打开位置")
			.setDesc("按住 Cmd/Ctrl 点击或中键点击时使用另一种。")
			.addDropdown((dd) =>
				dd
					.addOptions({ [OpenLocation.CurrentTab]: "当前标签页", [OpenLocation.NewTab]: "新标签页" })
					.setValue(settings.openLocation)
					.onChange(async (value) => {
						settings.openLocation = value as OpenLocation;
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Obsidian 无法打开的文件")
			.setDesc("如 xlsx、docx 等。")
			.addDropdown((dd) =>
				dd
					.addOptions({
						[UnsupportedFileAction.DefaultApp]: "用系统默认程序打开",
						[UnsupportedFileAction.ShowInFolder]: "在访达中显示",
					})
					.setValue(settings.unsupportedFileAction)
					.onChange(async (value) => {
						settings.unsupportedFileAction = value as UnsupportedFileAction;
						await save();
					}),
			);
		// endregion

		// region 搜索
		new Setting(containerEl).setName("搜索").setHeading();

		new Setting(containerEl).setName("匹配范围").addDropdown((dd) =>
			dd
				.addOptions({ [SearchScope.Name]: "仅文件名", [SearchScope.Path]: "完整路径" })
				.setValue(settings.searchScope)
				.onChange(async (value) => {
					settings.searchScope = value as SearchScope;
					await save();
				}),
		);

		new Setting(containerEl).setName("区分大小写").addToggle((toggle) =>
			toggle.setValue(settings.searchCaseSensitive).onChange(async (value) => {
				settings.searchCaseSensitive = value;
				await save();
			}),
		);
		// endregion

		// region 拖拽
		new Setting(containerEl).setName("拖拽").setHeading();

		new Setting(containerEl)
			.setName("移动前确认")
			.setDesc("拖拽移动文件或文件夹前弹窗确认。移动会自动更新库内链接。")
			.addToggle((toggle) =>
				toggle.setValue(settings.confirmBeforeMove).onChange(async (value) => {
					settings.confirmBeforeMove = value;
					await save();
				}),
			);
		// endregion

		// region 其他
		new Setting(containerEl).setName("其他").setHeading();

		new Setting(containerEl).setName("启动时自动打开文件树").addToggle((toggle) =>
			toggle.setValue(settings.openOnStartup).onChange(async (value) => {
				settings.openOnStartup = value;
				await save();
			}),
		);

		new Setting(containerEl)
			.setName("记住展开状态与滚动位置")
			.setDesc("下次启动 Obsidian 时恢复。")
			.addToggle((toggle) =>
				toggle.setValue(settings.rememberState).onChange(async (value) => {
					settings.rememberState = value;
					await save();
				}),
			);
		// endregion
	}
}
