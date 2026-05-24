" ============================================================
" .vimrc — minimal, portable, no plugin manager assumed
" Compatible with Vim 7.4+ and plain Vi fallback
" ============================================================

" --- Basics --------------------------------------------------
set nocompatible          " Disable Vi compatibility
filetype plugin indent on " Enable filetype detection
syntax enable             " Enable syntax highlighting

" --- Encoding ------------------------------------------------
set encoding=utf-8
set fileencoding=utf-8

" --- UI ------------------------------------------------------
set number                " Absolute line numbers
set relativenumber        " Relative line numbers
set cursorline            " Highlight current line
set showcmd               " Show partial commands in status bar
set showmatch             " Highlight matching brackets
set wildmenu              " Enhanced command-line completion
set laststatus=2          " Always show status line
set scrolloff=8           " Keep 8 lines above/below cursor
set sidescrolloff=8

" --- Search --------------------------------------------------
set hlsearch              " Highlight search results
set incsearch             " Incremental search
set ignorecase            " Case-insensitive search...
set smartcase             " ...unless uppercase is used

" Clear search highlight with Escape
nnoremap <Esc> :nohlsearch<CR>

" --- Indentation ---------------------------------------------
set expandtab             " Use spaces instead of tabs
set tabstop=4             " Tab width = 4 spaces
set shiftwidth=4          " Indent width = 4 spaces
set softtabstop=4
set autoindent
set smartindent

" --- Line handling -------------------------------------------
set wrap                  " Wrap long lines visually
set linebreak             " Break at word boundaries
set textwidth=0           " Don't hard-wrap

" --- Files ---------------------------------------------------
set autoread              " Reload files changed outside vim
set nobackup
set nowritebackup
set noswapfile
set undofile              " Persistent undo
if has('persistent_undo')
    let s:undodir = expand('~/.vim/undodir')
    if !isdirectory(s:undodir)
        call mkdir(s:undodir, 'p')
    endif
    let &undodir = s:undodir
endif

" --- Clipboard -----------------------------------------------
if has('clipboard')
    set clipboard=unnamedplus
endif

" --- Key mappings --------------------------------------------
let mapleader = ' '

" Quick save / quit
nnoremap <Leader>w :w<CR>
nnoremap <Leader>q :q<CR>

" Move between splits
nnoremap <C-h> <C-w>h
nnoremap <C-j> <C-w>j
nnoremap <C-k> <C-w>k
nnoremap <C-l> <C-w>l

" Stay in visual mode after indent
vnoremap < <gv
vnoremap > >gv

" Move selected lines up/down
vnoremap J :m '>+1<CR>gv=gv
vnoremap K :m '<-2<CR>gv=gv

" Yank to end of line (consistent with D/C)
nnoremap Y y$

" Keep cursor centred on search navigation
nnoremap n nzzzv
nnoremap N Nzzzv

" --- Colours -------------------------------------------------
set background=dark
if has('termguicolors')
    set termguicolors
endif

" --- Netrw (built-in file browser) ---------------------------
let g:netrw_banner    = 0   " Hide banner
let g:netrw_liststyle = 3   " Tree view
let g:netrw_winsize   = 25  " 25% width

" --- Local overrides -----------------------------------------
" Source machine-specific config if it exists
if filereadable(expand('~/.vimrc.local'))
    source ~/.vimrc.local
endif
