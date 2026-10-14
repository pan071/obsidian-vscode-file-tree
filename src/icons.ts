/**
 * 文件与文件夹图标渲染：优先使用 Material Icon Theme，缺失时回退到 Obsidian 内置 Lucide 图标
 *
 * @author 启年
 * @createTime 2026-10-14 13:27
 */
import { App, TAbstractFile, TFolder, setIcon } from "obsidian";
import { MaterialIconAdapter } from "./internal";
import { IconSource } from "./types";

/** 内置图标：扩展名 → Lucide 图标名 */
const BUILTIN_FILE_ICONS: Record<string, string> = {
	md: "file-text",
	txt: "file-text",
	pdf: "file-text",
	doc: "file-text",
	docx: "file-text",
	canvas: "layout-dashboard",
	base: "table",
	xlsx: "file-spreadsheet",
	xls: "file-spreadsheet",
	csv: "file-spreadsheet",
	json: "file-json",
	png: "file-image",
	jpg: "file-image",
	jpeg: "file-image",
	gif: "file-image",
	webp: "file-image",
	svg: "file-image",
	bmp: "file-image",
	mp3: "file-audio",
	wav: "file-audio",
	m4a: "file-audio",
	mp4: "file-video",
	mov: "file-video",
	webm: "file-video",
	zip: "file-archive",
	rar: "file-archive",
	"7z": "file-archive",
	js: "file-code",
	ts: "file-code",
	java: "file-code",
	py: "file-code",
	sql: "file-code",
	html: "file-code",
	css: "file-code",
	xml: "file-code",
	sh: "file-code",
};

/** 图标尺寸（px） */
const ICON_SIZE = 16;

/**
 * 图标渲染器，每次整树渲染前调用 begin() 刷新 Material 插件状态
 *
 * @author 启年
 * @createTime 2026-10-14 13:27
 */
export class IconRenderer {
	/** Obsidian 应用实例 */
	private readonly app: App;
	/** 本轮渲染使用的 Material 适配器 */
	private material: MaterialIconAdapter | null = null;
	/** SVG 字符串 → 解析后的元素，避免重复解析 */
	private readonly svgCache = new Map<string, SVGElement | null>();

	/**
	 * 创建渲染器
	 *
	 * @param app Obsidian 应用实例
	 */
	constructor(app: App) {
		this.app = app;
	}

	/**
	 * 开始一轮渲染：重新探测 Material 插件（可能被启用或禁用）
	 *
	 * @param source 图标来源配置
	 */
	begin(source: IconSource): void {
		this.material = source === IconSource.Auto ? MaterialIconAdapter.tryGet(this.app) : null;
	}

	/**
	 * 清空 SVG 缓存（主题亮暗切换后调用）
	 */
	clearCache(): void {
		this.svgCache.clear();
	}

	/**
	 * 在容器中渲染图标
	 *
	 * @param el 图标容器
	 * @param item 文件或文件夹
	 * @param collapsed 文件夹是否折叠（文件忽略）
	 * @param source 图标来源配置
	 */
	render(el: HTMLElement, item: TAbstractFile, collapsed: boolean, source: IconSource): void {
		el.empty();
		if (source === IconSource.None) {
			return;
		}
		const isFolder = item instanceof TFolder;
		// 优先尝试 Material 图标
		if (this.material) {
			const svg = isFolder ? this.material.getFolderSvg(item.path, collapsed) : this.material.getFileSvg(item.path);
			const svgEl = svg ? this.parseSvg(svg) : null;
			if (svgEl) {
				el.appendChild(svgEl.cloneNode(true));
				el.addClass("is-material");
				return;
			}
		}
		// 回退到内置图标
		el.removeClass("is-material");
		if (isFolder) {
			setIcon(el, collapsed ? "folder" : "folder-open");
			return;
		}
		const ext = item.name.includes(".") ? item.name.slice(item.name.lastIndexOf(".") + 1).toLowerCase() : "";
		setIcon(el, BUILTIN_FILE_ICONS[ext] ?? "file");
	}

	/**
	 * 解析 SVG 字符串为元素（带缓存）
	 *
	 * @param svg SVG 字符串
	 * @returns SVG 元素，解析失败返回 null
	 */
	private parseSvg(svg: string): SVGElement | null {
		if (this.svgCache.has(svg)) {
			return this.svgCache.get(svg) ?? null;
		}
		let result: SVGElement | null = null;
		try {
			// 用 XML 解析器解析，避免 innerHTML 注入
			const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
			const root = doc.documentElement;
			if (root && root.nodeName.toLowerCase() === "svg") {
				const imported = activeDocument.importNode(root, true) as unknown as SVGElement;
				// 统一尺寸
				imported.setAttribute("width", String(ICON_SIZE));
				imported.setAttribute("height", String(ICON_SIZE));
				result = imported;
			}
		} catch {
			result = null;
		}
		this.svgCache.set(svg, result);
		return result;
	}
}
