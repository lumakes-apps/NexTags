import os
import base64
import binascii
from io import BytesIO
import tempfile
import warnings
from pathlib import Path
from PIL import Image, UnidentifiedImageError
from mutagen import File as MutagenFile
from mutagen.mp4 import MP4, MP4Cover
from mutagen.flac import FLAC, Picture
from mutagen.mp3 import MP3
from mutagen.id3 import APIC
from mutagen.oggvorbis import OggVorbis

MAX_COVER_BYTES = 10 * 1024 * 1024


def decode_cover_data(data_url):
    """驗證編輯器的圖片資料，保留原始 JPEG/PNG 位元組。"""
    try:
        header, encoded = data_url.split(',', 1)
        mime = header.removeprefix('data:').removesuffix(';base64')
        if header not in ('data:image/jpeg;base64', 'data:image/png;base64'):
            raise ValueError('封面僅支援 JPEG 或 PNG')
        if len(encoded) > ((MAX_COVER_BYTES + 2) // 3) * 4:
            raise ValueError('封面不能超過 10 MB')
        data = base64.b64decode(encoded, validate=True)
        if len(data) > MAX_COVER_BYTES:
            raise ValueError('封面不能超過 10 MB')
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as image:
                if image.format not in ('JPEG', 'PNG') or Image.MIME[image.format] != mime:
                    raise ValueError('封面格式與圖片內容不符')
                width, height = image.size
                if width * height > 20_000_000:
                    raise ValueError('封面尺寸過大')
                image.load()
        return data, mime, width, height
    except (binascii.Error, UnidentifiedImageError, OSError, Image.DecompressionBombWarning, Image.DecompressionBombError) as error:
        raise ValueError('無法讀取封面圖片，請選擇有效的 JPEG 或 PNG') from error


def write_audio_cover(file_path, cover):
    """更新內嵌正面封面及專輯資料夾的 cover.jpg/cover.png。"""
    data, mime, width, height = cover
    audio = MutagenFile(file_path)
    picture = Picture()
    picture.type = 3
    picture.mime = mime
    picture.width, picture.height, picture.depth = width, height, 24
    picture.data = data
    if isinstance(audio, FLAC):
        other_pictures = [p for p in audio.pictures if p.type != 3]
        audio.clear_pictures()
        audio.add_picture(picture)
        for other in other_pictures:
            audio.add_picture(other)
    elif isinstance(audio, MP3):
        if audio.tags is None:
            audio.add_tags()
        for key, tag in list(audio.tags.items()):
            if isinstance(tag, APIC) and tag.type == 3:
                del audio.tags[key]
        audio.tags.add(APIC(encoding=3, mime=mime, type=3, desc='Front cover', data=data))
    elif isinstance(audio, MP4):
        audio['covr'] = [MP4Cover(data, imageformat=MP4Cover.FORMAT_JPEG if mime == 'image/jpeg' else MP4Cover.FORMAT_PNG)]
    elif isinstance(audio, OggVorbis):
        other_pictures = [value for value in audio.get('metadata_block_picture', [])
                          if Picture(base64.b64decode(value)).type != 3]
        audio['metadata_block_picture'] = [base64.b64encode(picture.write()).decode('ascii')] + other_pictures
    else:
        raise ValueError('此音訊格式不支援封面寫入')

    folder = Path(file_path).parent
    cover_path = folder / ('cover.jpg' if mime == 'image/jpeg' else 'cover.png')
    # 先確認資料夾可寫，再修改音檔；以替換方式避免圖片讀到部分內容。
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(dir=folder, suffix='.tmp', delete=False) as output:
            temporary_path = Path(output.name)
            output.write(data)
        audio.save()
        os.chmod(temporary_path, 0o664)
        os.replace(temporary_path, cover_path)
        for name in ('cover.jpg', 'cover.jpeg', 'cover.png'):
            old_path = folder / name
            if old_path != cover_path and old_path.is_file():
                old_path.unlink()
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
    return str(cover_path)


def get_cover_data_from_audio(file_path):
    """從音訊檔案讀取 embedded cover data。"""
    try:
        # 使用 mutagen 讀取音訊檔案
        audio_file = MutagenFile(file_path)

        if audio_file is None:
            return None, None

        cover_data = None
        mime_type = None

        if isinstance(audio_file, MP4):
            # MP4/M4A 檔案
            if "covr" in audio_file.tags:
                artwork = audio_file.tags["covr"][0]
                cover_data = bytes(artwork)
                mime_type = "image/jpeg" if artwork.imageformat == MP4Cover.FORMAT_JPEG else "image/png"

        elif isinstance(audio_file, FLAC):
            # FLAC 檔案
            if audio_file.pictures:
                picture = next((p for p in audio_file.pictures if p.type == 3), audio_file.pictures[0])
                cover_data = picture.data
                mime_type = picture.mime

        elif isinstance(audio_file, MP3):
            # MP3 檔案
            if audio_file.tags:
                for tag in sorted(audio_file.tags.values(), key=lambda tag: not (isinstance(tag, APIC) and tag.type == 3)):
                    if isinstance(tag, APIC):
                        cover_data = tag.data
                        mime_type = tag.mime
                        break

        elif isinstance(audio_file, OggVorbis):
            # OGG Vorbis 檔案
            # OGG 使用 FLAC-style 圖片存儲
            if hasattr(audio_file, 'get') and audio_file.get('METADATA_BLOCK_PICTURE'):
                import base64
                try:
                    # 解碼 base64 編碼的圖片數據
                    picture_data = base64.b64decode(audio_file['METADATA_BLOCK_PICTURE'][0])
                    # 這裡需要解析 FLAC picture block，簡化處理
                    # 通常前面有一些元數據，實際圖片數據在後面
                    if len(picture_data) > 32:  # 基本的sanity check
                        # 嘗試找到 JPEG 或 PNG 頭部
                        jpeg_start = picture_data.find(b'\xff\xd8\xff')
                        png_start = picture_data.find(b'\x89PNG')
                        
                        if jpeg_start != -1:
                            cover_data = picture_data[jpeg_start:]
                            mime_type = "image/jpeg"
                        elif png_start != -1:
                            cover_data = picture_data[png_start:]
                            mime_type = "image/png"
                except Exception:
                    pass

        return cover_data, mime_type

    except Exception as e:
        print(f"讀取封面圖檔時發生錯誤: {str(e)}")

    return None, None


def extract_cover_from_audio(file_path, output_dir):
    """從音訊檔案提取封面圖並保存為 cover.jpg 或 cover.png"""
    try:
        # 確保輸出目錄存在
        os.makedirs(output_dir, exist_ok=True)

        cover_data, mime_type = get_cover_data_from_audio(file_path)

        # 如果成功提取到封面數據
        if cover_data and mime_type:
            # 決定檔案副檔名
            if mime_type == "image/jpeg":
                extension = ".jpg"
            elif mime_type == "image/png":
                extension = ".png"
            else:
                extension = ".jpg"  # 默認使用 jpg
            
            cover_path = os.path.join(output_dir, "cover" + extension)
            
            # 寫入封面圖檔
            with open(cover_path, "wb") as f:
                f.write(cover_data)
            
            return True, cover_path
            
    except Exception as e:
        print(f"提取封面圖檔時發生錯誤: {str(e)}")
    
    return False, ""


def save_cover_art(mp4_file, output_dir):
    """儲存 MP4 封面圖檔（保持向後兼容）"""
    try:
        # 取得 MP4 檔案中的封面圖檔
        if "covr" in mp4_file.tags:
            artwork = mp4_file.tags["covr"][0]
            # 根據封面圖檔的格式決定副檔名
            extension = (
                ".jpg" if artwork.imageformat == MP4Cover.FORMAT_JPEG else ".png"
            )
            cover_path = os.path.join(output_dir, "cover" + extension)

            # 確保輸出目錄存在
            os.makedirs(os.path.dirname(cover_path), exist_ok=True)

            # 寫入封面圖檔
            with open(cover_path, "wb") as f:
                f.write(artwork)
            return True
    except Exception as e:
        print(f"儲存封面圖檔時發生錯誤: {str(e)}")
    return False
