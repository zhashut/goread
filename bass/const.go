package bass

import "image/color"

/**
 * @author: zhashut
 * Date: 2025/4/12
 * Time: 18:54
 * Description: 常量
 */

// 应用程序常量
const (
	APPNAME string  = "goread"                         // 应用程序名称
	HEIGHT  float32 = 300                              // 默认窗口高度
	WIDTH   float32 = 450                              // 默认窗口宽度
	PACKAGE string  = "com.zhashut.goread.preferences" // 首选项包名
)

// 主题颜色
var (
	// PrimaryColor 主题主色调（红色）
	PrimaryColor = color.NRGBA{R: 209, G: 81, B: 88, A: 255}
)
