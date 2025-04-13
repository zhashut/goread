package bass

/**
 * @author: zhashut
 * Date: 2025/4/12
 * Time: 20:54
 * Description: 书籍阅读器
 */

import (
	"sort"
	"time"
)

// BookerSettings 阅读器设置
type BookerSettings struct {
	readStyle         ScrollType // 阅读方式
	autoScrollEnabled bool       // 自动滚动启用
	makeBookMark      bool       // 打书签
	showStatusBar     bool       // 显示状态栏
	recentPageCount   int        // 最近显示数量
	scrollSpeed       float32    // 滚动速度
	pageMargin        float32    // 页面间距
}

// Booker 书籍阅读器
type Booker struct {
	// 阅读器配置
	BookerSettings

	// 回调函数
	BookerCallback

	// 队列相关
	queue             []BookMeta   // 书籍元数据
	currentQueueIndex int          // 当前正在阅读的队列索引
	status            ReaderStatus // 当前阅读器状态
}

// BookerCallback 阅读器回调接口
type BookerCallback struct {
	// 状态回调
	statusCallback func(status ReaderStatus, err error) // 状态变化回调（加载中、阅读中等）

	// 页面相关回调
	pageChangeCallback     func(currentPage, totalPages int) // 页面切换回调
	progressUpdateCallback func(progress float32)            // 阅读进度更新回调（0-100%）
	scrollChangeCallback   func(offset float32)              // 滚动位置变化回调

	// 书签相关回调
	bookmarkAddCallback    func(page int, desc string) // 添加书签回调
	bookmarkRemoveCallback func(page int)              // 移除书签回调
	bookmarkLoadCallback   func(bookmarks []BookMark)  // 加载书签回调

	// 设置相关回调
	settingsChangeCallback func(settings *BookerSettings) // 设置变更回调

	// 文件相关回调
	fileOpenCallback  func(meta *BookMeta) // 文件打开回调
	fileCloseCallback func()               // 文件关闭回调
	fileAddCallback   func(meta *BookMeta) // 新文件添加到队列回调
}

// NewBooker 创建新的阅读器实例
func NewBooker(callback BookerCallback) *Booker {
	return &Booker{
		status: StatusIdle,
		BookerSettings: BookerSettings{
			readStyle:         ScrollTypeVertical,
			autoScrollEnabled: false,
			makeBookMark:      false,
			showStatusBar:     true,
			recentPageCount:   9,
			scrollSpeed:       1.0,
			pageMargin:        0.0,
		},
		queue:          make([]BookMeta, 0),
		BookerCallback: callback,
	}
}

// OpenBook 打开书籍
func (b *Booker) OpenBook(filePath string) error {
	// 更新状态为加载中
	b.setStatus(StatusLoading)

	// TODO: 实现文件加载逻辑
	meta := &BookMeta{
		FilePath: filePath,
		// ... 其他元数据初始化
	}

	// 添加到队列并触发回调
	b.queue = append(b.queue, *meta)
	b.currentQueueIndex = len(b.queue) - 1
	if b.fileAddCallback != nil {
		b.fileAddCallback(meta)
	}

	// 触发文件打开回调
	if b.fileOpenCallback != nil {
		b.fileOpenCallback(meta)
	}

	// 加载书签并触发回调
	if b.bookmarkLoadCallback != nil {
		// TODO: 从存储中加载书签
		bookmarks := []BookMark{}
		b.bookmarkLoadCallback(bookmarks)
	}

	// 更新状态为阅读中
	b.setStatus(StatusReading)
	return nil
}

// CloseBook 关闭当前书籍
func (b *Booker) CloseBook() {
	if b.status == StatusIdle {
		return
	}

	// 触发关闭回调
	if b.fileCloseCallback != nil {
		b.fileCloseCallback()
	}

	b.setStatus(StatusIdle)
}

// NextPage 下一页
func (b *Booker) NextPage() {
	if b.status != StatusReading {
		return
	}

	// TODO: 实现翻到下一页的逻辑
	currentPage := 1  // 示例值
	totalPages := 100 // 示例值

	// 触发页面变化回调
	if b.pageChangeCallback != nil {
		b.pageChangeCallback(currentPage, totalPages)
	}

	// 更新进度
	if b.progressUpdateCallback != nil {
		progress := float32(currentPage) / float32(totalPages) * 100
		b.progressUpdateCallback(progress)
	}
}

// PrevPage 上一页
func (b *Booker) PrevPage() {
	if b.status != StatusReading {
		return
	}

	// TODO: 实现翻到上一页的逻辑
	currentPage := 1  // 示例值
	totalPages := 100 // 示例值

	// 触发页面变化回调
	if b.pageChangeCallback != nil {
		b.pageChangeCallback(currentPage, totalPages)
	}

	// 更新进度
	if b.progressUpdateCallback != nil {
		progress := float32(currentPage) / float32(totalPages) * 100
		b.progressUpdateCallback(progress)
	}
}

// JumpToPage 跳转到指定页
func (b *Booker) JumpToPage(pageNum int) {
	if b.status != StatusReading {
		return
	}

	// TODO: 实现跳转到指定页的逻辑
	currentPage := pageNum
	totalPages := 100 // 示例值

	// 触发页面变化回调
	if b.pageChangeCallback != nil {
		b.pageChangeCallback(currentPage, totalPages)
	}

	// 更新进度
	if b.progressUpdateCallback != nil {
		progress := float32(currentPage) / float32(totalPages) * 100
		b.progressUpdateCallback(progress)
	}
}

// AddBookmark 添加书签
func (b *Booker) AddBookmark(page int, desc string) {
	if b.status != StatusReading {
		return
	}

	// 触发添加书签回调
	if b.bookmarkAddCallback != nil {
		b.bookmarkAddCallback(page, desc)
	}
}

// RemoveBookmark 移除书签
func (b *Booker) RemoveBookmark(page int) {
	if b.status != StatusReading {
		return
	}

	// 触发移除书签回调
	if b.bookmarkRemoveCallback != nil {
		b.bookmarkRemoveCallback(page)
	}
}

// UpdateSettings 更新阅读器设置
func (b *Booker) UpdateSettings(settings BookerSettings) {
	b.BookerSettings = settings

	// 触发设置变更回调
	if b.settingsChangeCallback != nil {
		b.settingsChangeCallback(&b.BookerSettings)
	}
}

// GetCurrentBook 获取当前正在阅读的书籍
func (b *Booker) GetCurrentBook() *BookMeta {
	if len(b.queue) == 0 || b.currentQueueIndex < 0 || b.currentQueueIndex >= len(b.queue) {
		return nil
	}
	return &b.queue[b.currentQueueIndex]
}

// setStatus 设置阅读器状态
func (b *Booker) setStatus(status ReaderStatus) {
	if b.status == status {
		return
	}

	b.status = status
	if b.statusCallback != nil {
		b.statusCallback(status, nil)
	}
}

// GetStatus 获取当前状态
func (b *Booker) GetStatus() ReaderStatus {
	return b.status
}

// GetSettings 获取当前设置
func (b *Booker) GetSettings() *BookerSettings {
	return &b.BookerSettings
}

// UpdateScroll 更新滚动位置
func (b *Booker) UpdateScroll(offset float32) {
	if b.status != StatusReading {
		return
	}

	if b.scrollChangeCallback != nil {
		b.scrollChangeCallback(offset)
	}
}

// LoadBookmarks 加载书签
func (b *Booker) LoadBookmarks() {
	if b.status != StatusReading {
		return
	}

	// TODO: 从存储中加载书签
	bookmarks := []BookMark{}

	if b.bookmarkLoadCallback != nil {
		b.bookmarkLoadCallback(bookmarks)
	}
}

// AddToQueue 添加书籍到队列
func (b *Booker) AddToQueue(filePath string) error {
	meta := &BookMeta{
		FilePath: filePath,
		// TODO: 初始化其他元数据
	}

	b.queue = append(b.queue, *meta)

	if b.fileAddCallback != nil {
		b.fileAddCallback(meta)
	}

	return nil
}

// LoadSampleBooks 加载示例书籍数据（仅用于测试）
func (b *Booker) LoadSampleBooks() {
	sampleBooks := []BookMeta{
		{
			Name:          "三体",
			FilePath:      "samples/santi.pdf",
			Group:         "科幻",
			Progress:      0,
			TotalPage:     400,
			CurrentPage:   1,
			LastPage:      1,
			LastRead:      time.Now().Add(-24 * time.Hour),
			GroupPosition: 0,
			ScaleFactor:   1.0,
			CoverPath:     "res/hitGirl.png",
			Bookmarks: []BookMark{
				{Page: 42, Desc: "第一次接触", CreatedAt: time.Now().Add(-48 * time.Hour)},
				{Page: 156, Desc: "智子出现", CreatedAt: time.Now().Add(-36 * time.Hour)},
			},
		},
		{
			Name:          "活着",
			FilePath:      "samples/huozhe.pdf",
			Group:         "文学",
			Progress:      17.5,
			TotalPage:     200,
			CurrentPage:   1,
			LastPage:      1,
			LastRead:      time.Now().Add(-48 * time.Hour),
			GroupPosition: 0,
			ScaleFactor:   1.0,
			CoverPath:     "res/hitGirl.png",
		},
		{
			Name:          "百年孤独",
			FilePath:      "samples/bainangudu.pdf",
			Group:         "外国文学",
			Progress:      0,
			TotalPage:     350,
			CurrentPage:   1,
			LastPage:      1,
			LastRead:      time.Now().Add(-72 * time.Hour),
			GroupPosition: 0,
			ScaleFactor:   1.0,
			CoverPath:     "res/hitGirl.png",
			Bookmarks: []BookMark{
				{Page: 88, Desc: "第一代布恩迪亚", CreatedAt: time.Now().Add(-60 * time.Hour)},
			},
		},
		{
			Name:          "围城",
			FilePath:      "samples/weicheng.pdf",
			Group:         "文学",
			Progress:      0,
			TotalPage:     320,
			CurrentPage:   1,
			LastPage:      1,
			LastRead:      time.Now().Add(-12 * time.Hour),
			GroupPosition: 1,
			ScaleFactor:   1.0,
			CoverPath:     "res/hitGirl.png",
		},
		{
			Name:          "平凡的世界",
			FilePath:      "samples/pingfan.pdf",
			Group:         "文学",
			Progress:      0,
			TotalPage:     500,
			CurrentPage:   1,
			LastPage:      1,
			LastRead:      time.Now().Add(-36 * time.Hour),
			GroupPosition: 2,
			ScaleFactor:   1.0,
			CoverPath:     "res/hitGirl.png",
			Bookmarks: []BookMark{
				{Page: 125, Desc: "孙少平进城", CreatedAt: time.Now().Add(-24 * time.Hour)},
				{Page: 253, Desc: "田晓霞登场", CreatedAt: time.Now().Add(-12 * time.Hour)},
			},
		},
	}

	// 清空现有队列
	//b.queue = []BookMeta{}
	b.currentQueueIndex = -1

	// 添加示例书籍到队列
	for _, book := range sampleBooks {
		b.queue = append(b.queue, book)
		if b.fileAddCallback != nil {
			b.fileAddCallback(&book)
		}
	}

	// 设置当前书籍为第一本
	if len(b.queue) > 0 {
		b.currentQueueIndex = 0
		if b.fileOpenCallback != nil {
			b.fileOpenCallback(&b.queue[0])
		}
	}
}

func (b *Booker) GetRecentBooks() []BookMeta {
	sort.Slice(b.queue, func(i, j int) bool {
		return b.queue[i].LastRead.UnixMilli() > b.queue[j].LastRead.UnixMilli()
	})
	bl := len(b.queue)
	if b.recentPageCount == -1 || bl < b.recentPageCount {
		return b.queue[:]
	}
	return b.queue[:b.recentPageCount+1]
}
