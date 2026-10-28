# Gera as imagens do instalador do Windows (GOALS 22) a partir de resources/icon.png:
#   resources/installer/sidebar.bmp  164 x 314  barra lateral das paginas de boas-vindas e fim
#   resources/installer/header.bmp   150 x 57   canto das paginas do meio
# Os dois sao BMP de 24 bits sem compressao, o unico formato que o NSIS aceita. Os arquivos gerados
# ficam no repositorio: rode este script de novo so quando a identidade visual mudar.
param(
  [string]$OutDir = (Join-Path $PSScriptRoot '..\resources\installer'),
  [string]$IconPath = (Join-Path $PSScriptRoot '..\resources\icon.png')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# Cores do tema escuro do app (src/renderer/src/tokens.css).
$canvas = [System.Drawing.Color]::FromArgb(15, 23, 42)
$surface = [System.Drawing.Color]::FromArgb(30, 41, 59)
$line = [System.Drawing.Color]::FromArgb(51, 65, 85)
$accent = [System.Drawing.Color]::FromArgb(59, 130, 246)
$textPrimary = [System.Drawing.Color]::FromArgb(241, 245, 249)
$textMuted = [System.Drawing.Color]::FromArgb(148, 163, 184)

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$outFull = (Resolve-Path $OutDir).Path
$icon = [System.Drawing.Image]::FromFile((Resolve-Path $IconPath).Path)

function New-Canvas([int]$width, [int]$height) {
  $bitmap = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  return @{ Bitmap = $bitmap; Graphics = $g }
}

function New-RoundedRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

# ---- barra lateral: 164 x 314 -------------------------------------------------------------
$side = New-Canvas 164 314
$g = $side.Graphics
$rect = New-Object System.Drawing.Rectangle(0, 0, 164, 314)
$gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $canvas, $surface, 90.0)
$g.FillRectangle($gradient, $rect)
$g.FillRectangle((New-Object System.Drawing.SolidBrush($accent)), 0, 0, 164, 4)

$tile = New-RoundedRect 40 52 84 84 16
$g.FillPath((New-Object System.Drawing.SolidBrush($surface)), $tile)
$g.DrawPath((New-Object System.Drawing.Pen($line, 1)), $tile)
# O icone tem 48 x 48: fica no tamanho original, sem ampliar (ampliar borraria).
$g.DrawImage($icon, 58, 70, 48, 48)

$center = New-Object System.Drawing.StringFormat
$center.Alignment = [System.Drawing.StringAlignment]::Center
$titleFont = New-Object System.Drawing.Font('Segoe UI Semibold', 15, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$subFont = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString('OpenPortal', $titleFont, (New-Object System.Drawing.SolidBrush($textPrimary)), (New-Object System.Drawing.RectangleF(0, 150, 164, 24)), $center)
$g.DrawString('Remote Desktop Gateway', $subFont, (New-Object System.Drawing.SolidBrush($textMuted)), (New-Object System.Drawing.RectangleF(0, 176, 164, 18)), $center)
$side.Bitmap.Save((Join-Path $outFull 'sidebar.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
$g.Dispose(); $side.Bitmap.Dispose()

# ---- topo: 150 x 57 -----------------------------------------------------------------------
$head = New-Canvas 150 57
$g = $head.Graphics
$g.Clear([System.Drawing.Color]::White)
$badge = New-RoundedRect 90 5 48 47 10
$g.FillPath((New-Object System.Drawing.SolidBrush($canvas)), $badge)
$g.DrawImage($icon, 90, 5, 48, 47)
$head.Bitmap.Save((Join-Path $outFull 'header.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
$g.Dispose(); $head.Bitmap.Dispose()

$icon.Dispose()
Write-Host "Imagens gravadas em $outFull"
