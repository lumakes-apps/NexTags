from pydantic import BaseModel
from typing import Dict, Any, Optional, List

class AudioTagsRequest(BaseModel):
    path: str

class AudioTagsResponse(BaseModel):
    tags: Dict[str, Any]
    success: bool
    message: Optional[str] = None
    path: Optional[str] = None
    folder: Optional[str] = None

class AudioUpdateRequest(BaseModel):
    path: str
    tags: List[Dict[str, Any]]
    cover_data: Optional[str] = None
    # 依改到的欄位把檔案移到新路徑（等 Navidrome 掃描過標籤後才實際搬移）
    move: bool = False
    # 確認視窗中自訂的檔名（不含副檔名也可）
    move_filename: Optional[str] = None

class MovePreviewRequest(BaseModel):
    path: str
    tags: List[Dict[str, Any]]
    filename: Optional[str] = None

class AudioUpdateResponse(BaseModel):
    success: bool
    message: Optional[str] = None
    updated_tags: Optional[Dict[str, Any]] = None
    cover_path: Optional[str] = None
    pending_move: Optional[Dict[str, Any]] = None
