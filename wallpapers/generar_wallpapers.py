import sys
from PIL import Image, ImageOps, ImageFilter, ImageEnhance
U="/root/.claude/uploads/8864d6f8-d01a-527c-ba42-53036c05e374/"
OUT="/home/user/practicas/wallpapers/2k/"
W,H=2560,1440
# (archivo, nombre, posición vertical del recorte 0..1)
fotos=[("1cd3f0f5","01-atardecer-montana",0.60),("1c8aee18","02-atardecer-montana-2",0.62),
 ("b8c944b4","03-playa",0.56),("bf4fce7d","04-ciudad",0.62),("86bddf4e","05-esquina",0.58),
 ("02b56c3e","06-iglesia",0.53),("38e0a08b","07-area-descanso",0.55)]
for f,name,pos in fotos:
    im=ImageOps.exif_transpose(Image.open(U+f+"-image.jpg")).convert("RGB")
    iw,ih=im.size
    # 1) recorte 16:9 a pantalla completa
    ch=round(iw*9/16)
    if ch<=ih:
        top=round((ih-ch)*pos); box=(0,top,iw,top+ch)
    else:
        cw=round(ih*16/9); l=(iw-cw)//2; box=(l,0,l+cw,ih)
    im.crop(box).resize((W,H),Image.LANCZOS).save(OUT+name+"-recorte.jpg",quality=95,subsampling=0)
    # 2) foto completa sobre fondo desenfocado
    if ih>iw:
        bg=ImageOps.fit(im,(W,H),Image.LANCZOS).filter(ImageFilter.GaussianBlur(40))
        bg=ImageEnhance.Brightness(bg).enhance(0.6)
        fh=H; fw=round(iw*fh/ih)
        fg=im.resize((fw,fh),Image.LANCZOS)
        bg.paste(fg,((W-fw)//2,0))
        bg.save(OUT+name+"-completa.jpg",quality=95,subsampling=0)
    print(name,box)
