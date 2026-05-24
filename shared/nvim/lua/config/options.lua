-- Leader keys (must be set before lazy loads plugins)
vim.g.mapleader = " "
vim.g.maplocalleader = " "

local opt = vim.opt

-- Line numbers
opt.number = true
opt.relativenumber = true

-- Tabs & indentation
opt.tabstop = 4
opt.shiftwidth = 4
opt.expandtab = true
opt.autoindent = true
opt.smartindent = true

-- Line wrapping
opt.wrap = false

-- Search
opt.ignorecase = true
opt.smartcase = true
opt.hlsearch = true
opt.incsearch = true

-- Appearance
opt.termguicolors = true
opt.signcolumn = "yes"
opt.cursorline = true
opt.scrolloff = 8
opt.sidescrolloff = 8
opt.colorcolumn = ""

-- Split behavior
opt.splitbelow = true
opt.splitright = true

-- Clipboard (system)
opt.clipboard = "unnamedplus"

-- Mouse support
opt.mouse = "a"

-- Persistent undo
opt.undofile = true

-- Faster update time (helps gitsigns, hover)
opt.updatetime = 250
opt.timeoutlen = 500

-- Completion menu behavior
opt.completeopt = "menu,menuone,noselect"

-- No swap files
opt.swapfile = false
opt.backup = false

-- Show invisible chars
opt.list = true
opt.listchars = { tab = "» ", trail = "·", nbsp = "␣" }

-- Better diffs
opt.diffopt:append("linematch:60")
opt.diffopt:append("algorithm:histogram")
