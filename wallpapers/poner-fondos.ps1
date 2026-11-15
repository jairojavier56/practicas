# Pone un fondo distinto en cada monitor (Windows 10/11).
#  - Monitor mas grande (2K, 2560x1440): 2k\09-niebla-montana.jpg
#  - Monitor mas pequeno (Full HD, 1920x1080): 1080p\08-calle-otono.jpg
# Las imagenes se copian a  Imagenes\Fondos  para que Windows no las pierda.

$ErrorActionPreference = 'Stop'
$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$img2k     = Join-Path $base '2k\09-niebla-montana.jpg'
$imgFullHD = Join-Path $base '1080p\08-calle-otono.jpg'

foreach ($f in @($img2k, $imgFullHD)) {
    if (-not (Test-Path $f)) { Write-Host "No encuentro la imagen: $f" -ForegroundColor Red; Read-Host 'Pulsa Enter para salir'; exit 1 }
}

$dest = Join-Path ([Environment]::GetFolderPath('MyPictures')) 'Fondos'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$dest2k     = Join-Path $dest 'niebla-montana-2k.jpg'
$destFullHD = Join-Path $dest 'calle-otono-fullhd.jpg'
Copy-Item $img2k $dest2k -Force
Copy-Item $imgFullHD $destFullHD -Force

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct WPRECT { public int Left; public int Top; public int Right; public int Bottom; }

[ComImport, Guid("B92B56A9-8B55-4E14-9A89-0199BBB6F93B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDesktopWallpaper {
    void SetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID, [MarshalAs(UnmanagedType.LPWStr)] string wallpaper);
    [return: MarshalAs(UnmanagedType.LPWStr)] string GetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID);
    [return: MarshalAs(UnmanagedType.LPWStr)] string GetMonitorDevicePathAt(uint monitorIndex);
    uint GetMonitorDevicePathCount();
    WPRECT GetMonitorRECT([MarshalAs(UnmanagedType.LPWStr)] string monitorID);
    void SetBackgroundColor(uint color);
    uint GetBackgroundColor();
    void SetPosition(int position);
    int GetPosition();
}

[ComImport, Guid("C2CF3110-460E-4fc1-B9D0-8A1C0C9CC4BD")]
public class DesktopWallpaperClass { }

public static class Wallpaper {
    public static IDesktopWallpaper Create() { return (IDesktopWallpaper)(new DesktopWallpaperClass()); }
}
'@

$dw = [Wallpaper]::Create()
$count = $dw.GetMonitorDevicePathCount()
$monitores = @()
for ($i = 0; $i -lt $count; $i++) {
    $id = $dw.GetMonitorDevicePathAt($i)
    try { $r = $dw.GetMonitorRECT($id) } catch { continue }   # monitor desconectado
    $monitores += [pscustomobject]@{ Id = $id; Ancho = $r.Right - $r.Left; Alto = $r.Bottom - $r.Top }
}

if ($monitores.Count -lt 2) {
    Write-Host "Solo he encontrado $($monitores.Count) monitor(es) activo(s)." -ForegroundColor Yellow
    Read-Host 'Pulsa Enter para salir'; exit 1
}

$orden = $monitores | Sort-Object { $_.Ancho * $_.Alto } -Descending
$grande  = $orden[0]
$pequeno = $orden[1]

$dw.SetPosition(4)   # 4 = Rellenar
$dw.SetWallpaper($grande.Id,  $dest2k)
$dw.SetWallpaper($pequeno.Id, $destFullHD)

Write-Host "Listo:" -ForegroundColor Green
Write-Host ("  Monitor grande  ({0}x{1}) -> niebla con la camioneta" -f $grande.Ancho, $grande.Alto)
Write-Host ("  Monitor pequeno ({0}x{1}) -> calle de otono" -f $pequeno.Ancho, $pequeno.Alto)
Read-Host 'Pulsa Enter para cerrar'
