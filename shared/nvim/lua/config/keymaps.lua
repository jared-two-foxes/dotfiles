local map = vim.keymap.set

-- ─── Window navigation ────────────────────────────────────────────────────────
map("n", "<C-h>", "<C-w>h", { desc = "Go to left window" })
map("n", "<C-j>", "<C-w>j", { desc = "Go to bottom window" })
map("n", "<C-k>", "<C-w>k", { desc = "Go to top window" })
map("n", "<C-l>", "<C-w>l", { desc = "Go to right window" })

-- ─── Window resizing ──────────────────────────────────────────────────────────
map("n", "<C-Up>",    "<cmd>resize +2<cr>",          { desc = "Increase window height" })
map("n", "<C-Down>",  "<cmd>resize -2<cr>",          { desc = "Decrease window height" })
map("n", "<C-Left>",  "<cmd>vertical resize -2<cr>", { desc = "Decrease window width" })
map("n", "<C-Right>", "<cmd>vertical resize +2<cr>", { desc = "Increase window width" })

-- ─── Buffer navigation ────────────────────────────────────────────────────────
map("n", "<S-h>",      "<cmd>bprevious<cr>", { desc = "Prev buffer" })
map("n", "<S-l>",      "<cmd>bnext<cr>",     { desc = "Next buffer" })
map("n", "<leader>bd", "<cmd>bdelete<cr>",   { desc = "Delete buffer" })

-- ─── Search ───────────────────────────────────────────────────────────────────
map("n", "<Esc>", "<cmd>nohlsearch<cr>", { desc = "Clear search highlight" })

-- ─── Indentation (keep selection) ────────────────────────────────────────────
map("v", "<", "<gv", { desc = "Indent left" })
map("v", ">", ">gv", { desc = "Indent right" })

-- ─── Move lines ───────────────────────────────────────────────────────────────
map("n", "<A-j>", "<cmd>m .+1<cr>==",        { desc = "Move line down" })
map("n", "<A-k>", "<cmd>m .-2<cr>==",        { desc = "Move line up" })
map("v", "<A-j>", ":m '>+1<cr>gv=gv",       { desc = "Move selection down" })
map("v", "<A-k>", ":m '<-2<cr>gv=gv",       { desc = "Move selection up" })

-- ─── File ─────────────────────────────────────────────────────────────────────
map("n", "<leader>w", "<cmd>w<cr>",  { desc = "Save file" })
map("n", "<leader>q", "<cmd>q<cr>",  { desc = "Quit" })
map("n", "<leader>Q", "<cmd>qa<cr>", { desc = "Quit all" })

-- ─── Misc ─────────────────────────────────────────────────────────────────────
-- Don't yank on paste in visual mode
map("v", "p", '"_dP', { desc = "Paste without yanking" })
-- Better up/down on wrapped lines
map("n", "j", "v:count == 0 ? 'gj' : 'j'", { expr = true, desc = "Down" })
map("n", "k", "v:count == 0 ? 'gk' : 'k'", { expr = true, desc = "Up" })
