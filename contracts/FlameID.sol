// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/utils/Base64.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/// @title FlameID — on-chain daily check-in streaks for Agent ID holders
/// @notice Binance Agent ID holders check in once per UTC day and build a
///         consecutive-day streak. Reaching a milestone (7 / 14 / 30 / 60 /
///         100 days) lets the wallet claim a soulbound badge NFT whose
///         artwork is fully on-chain (SVG in tokenURI). Every interaction
///         is provably tied to a real Agent ID: the contract reads the
///         SPACE ID Agent ID registry on every state-changing call.
///
///         Referrals: a first-time check-in can name a referrer (a wallet
///         that already checked in before). When the invitee reaches a
///         3-day streak, the referral qualifies and the referrer earns one
///         streak shield (max 3 shields).
///
///         Streak shields: if a wallet misses exactly one day and still
///         holds a shield, the shield is spent automatically and the streak
///         is kept instead of resetting to 1. Missing 2+ days, or missing
///         a day with no shield left, resets the streak as usual.
///
///         Genesis badge: a one-time soulbound badge claimable from the
///         first check-in, but ONLY during the first 7 days after deploy.
///         After that the window closes forever — latecomers can never get
///         it.
///
///         Reputation score: `scoreOf` is a pure view (max 140) built from
///         the wallet's current streak (max 50), total check-ins (max 30),
///         qualified referrals (max 30), account age in days (max 20) and
///         shields held (max 10). `isActiveAgent` lets any other dApp gate
///         on it: true when the wallet registered, checked in within the
///         last 2 UTC days, and scores at least `minScore`.
///
///         Season 1: the first 14 days, from deploy until 2026-12-09
///         08:00 UTC (submission close). The contract tracks each wallet's
///         check-in days, streak and best clean (no shield used) streak
///         inside the season, plus a live top-3 leaderboard. A wallet that
///         checks in on all 7 days of any week of the season can claim the
///         Survivor badge; the top 3 season streaks at season end can claim
///         the Champion badge. After the season ends, season state freezes
///         (view-only) but daily check-ins keep working.
/// @dev No owner, no admin, no pause, no fees, no token, no upgradeability,
///      no withdrawals. The deployer deploys once; afterwards nobody can
///      change anything. All state-changing functions are non-payable:
///      every interaction costs only gas (value must be 0).
///      Days are UTC days: day = block.timestamp / 86400.
///      Badges are soulbound: every transfer / approval reverts.
///      The giveaway (if the project wins a hackathon prize) is OFF-CHAIN
///      and is NOT part of this contract.
/// @custom:registry SPACE ID Agent ID (ERC-721, non-transferable), BSC:
///         0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F
interface IAgentID {
    function balanceOf(address account) external view returns (uint256);
}

contract FlameID is ERC721 {
    using Strings for uint256;

    /// @notice SPACE ID Agent ID registry on BNB Chain.
    IAgentID public constant AGENT_ID_REGISTRY =
        IAgentID(0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F);

    /// @notice One day in seconds. UTC day index = block.timestamp / 86400.
    uint256 public constant SECONDS_PER_DAY = 86400;

    /// @notice A referral only qualifies once the invitee reaches this streak.
    uint8 public constant REFERRAL_QUALIFY_STREAK = 3;

    /// @notice Maximum streak shields a wallet can hold at once.
    uint256 public constant MAX_SHIELDS = 3;

    /// @notice Season 1 ends at the hackathon submission close:
    ///         2026-12-09 08:00:00 UTC (unix 1796803200, verified with
    ///         `date -u -d "2026-12-09 08:00:00 UTC" +%s`).
    uint256 public constant SEASON_END = 1796803200;

    /// @notice Special badge kinds (0 = milestone badge, see _tokenKind).
    uint8 public constant GENESIS_KIND = 1;
    uint8 public constant SURVIVOR_KIND = 2;
    uint8 public constant CHAMPION_KIND = 3;

    /// @notice Season 1 starts at deploy (block.timestamp in constructor).
    uint256 public immutable SEASON_START;
    /// @notice Genesis badge window closes 7 days after deploy.
    uint256 public immutable GENESIS_DEADLINE;

    /// @notice Per-wallet streak state. Fields are uint64 (packed: the
    ///         whole struct fits in 2 storage slots) to keep the first
    ///         check-in cheap: streaks, day counts and day indexes are
    ///         all far below 2**64.
    struct StreakInfo {
        uint64 currentStreak;
        uint64 longestStreak;
        uint64 totalCheckIns;
        uint64 lastCheckInDay;
        uint64 firstCheckInDay;
    }

    /// @notice Season state per wallet. Packed like StreakInfo (2 slots).
    struct SeasonInfo {
        uint64 checkInDays;
        uint64 currentStreak;
        uint64 bestStreak;
        uint64 currentCleanStreak;
        uint64 bestCleanStreak;
        uint64 lastCheckInDay;
    }

    /// @dev wallet => streak state.
    mapping(address => StreakInfo) private _streaks;
    /// @dev wallet => Season 1 state.
    mapping(address => SeasonInfo) private _seasons;
    /// @dev live top-3 Season 1 wallets by best season streak (descending).
    address[3] private _seasonTop3;
    /// @dev ordered list of wallets that ever checked in (for counting / listing).
    address[] private _streakers;
    /// @dev wallet => milestone => badge claimed?
    mapping(address => mapping(uint8 => bool)) private _badgeClaimed;
    /// @dev wallet => milestone => badge tokenId (0 = none).
    mapping(address => mapping(uint8 => uint256)) private _badgeTokenId;
    /// @dev badge tokenId => milestone it was claimed for.
    mapping(uint256 => uint8) private _badgeMilestone;
    /// @dev badge tokenId => special kind (0 = milestone badge, 1 Genesis,
    ///      2 Survivor, 3 Champion).
    mapping(uint256 => uint8) private _tokenKind;
    /// @dev wallet => special kind => claimed?
    mapping(address => mapping(uint8 => bool)) private _specialClaimed;
    /// @dev wallet => special kind => badge tokenId (0 = none).
    mapping(address => mapping(uint8 => uint256)) private _specialTokenId;
    /// @dev total check-ins across all wallets.
    uint256 private _totalCheckIns;
    /// @dev last badge tokenId minted (starts at 0, first badge is #1).
    uint256 private _nextTokenId;

    /// @dev invitee => referrer (address(0) = no referrer). Set once, on
    ///      the invitee's very first check-in.
    mapping(address => address) private _referredBy;
    /// @dev invitee => referral already qualified (shield awarded or capped).
    mapping(address => bool) private _referralQualified;
    /// @dev referrer => number of QUALIFIED referrals (invitee reached a
    ///      3-day streak).
    mapping(address => uint256) private _referralCount;
    /// @dev wallet => streak shields currently held.
    mapping(address => uint256) private _shields;

    /// @notice Emitted on every successful daily check-in.
    event CheckedIn(
        address indexed user,
        uint256 day,
        uint256 currentStreak
    );
    /// @notice Emitted when a wallet claims a milestone badge.
    event BadgeClaimed(
        address indexed user,
        uint8 milestone,
        uint256 tokenId
    );
    /// @notice Emitted when a wallet claims the Genesis badge.
    event GenesisClaimed(address indexed user, uint256 tokenId);
    /// @notice Emitted when a wallet claims the Season 1 Survivor badge.
    event SurvivorClaimed(address indexed user, uint256 tokenId);
    /// @notice Emitted when a top-3 Season 1 wallet claims the Champion badge.
    event ChampionClaimed(address indexed user, uint256 tokenId);
    /// @notice Emitted when a first check-in names a valid referrer.
    event ReferralRecorded(
        address indexed invitee,
        address indexed referrer
    );
    /// @notice Emitted when a referrer earns a shield (totalShields is the
    ///         referrer's new shield balance).
    event ShieldEarned(address indexed referrer, uint256 totalShields);
    /// @notice Emitted when a shield is spent automatically to save a
    ///         streak after exactly one missed day (streakKept is the
    ///         streak value that was preserved).
    event ShieldUsed(address indexed user, uint256 streakKept);

    /// @notice Caller does not hold an Agent ID.
    error NotAgentIDHolder();
    /// @notice Caller already checked in today (UTC day).
    error AlreadyCheckedInToday();
    /// @notice Milestone is not one of 7 / 14 / 30 / 60 / 100.
    error InvalidMilestone();
    /// @notice Wallet's longest streak is below the milestone.
    error StreakTooShort();
    /// @notice Wallet already claimed the badge for this milestone.
    error BadgeAlreadyClaimed();
    /// @notice Badges are soulbound: transfers and approvals are blocked.
    error Soulbound();
    /// @notice tokenId does not exist.
    error NonexistentBadgeToken();
    /// @notice The 7-day Genesis window has closed.
    error GenesisWindowClosed();
    /// @notice Genesis requires at least one check-in first.
    error GenesisRequiresCheckIn();
    /// @notice The season is not over yet.
    error SeasonNotOver();
    /// @notice Caller is not in the Season 1 top 3.
    error NotSeasonTop3();

    /// @dev Reverts unless the caller currently holds an Agent ID.
    modifier onlyAgentIDHolder() {
        if (AGENT_ID_REGISTRY.balanceOf(msg.sender) == 0) {
            revert NotAgentIDHolder();
        }
        _;
    }

    constructor() ERC721("FlameID Badge", "FLAME") {
        SEASON_START = block.timestamp;
        GENESIS_DEADLINE = block.timestamp + 7 days;
    }

    /// @notice The five badge milestones, in days.
    function milestones() external pure returns (uint8[5] memory) {
        return [uint8(7), 14, 30, 60, 100];
    }

    /// @notice Current UTC day index (block.timestamp / 86400).
    function currentDay() public view returns (uint256) {
        return block.timestamp / SECONDS_PER_DAY;
    }

    /// @notice Check in for today. One check-in per wallet per UTC day.
    ///         Checking in the day right after the previous check-in grows
    ///         the streak by 1; missing exactly one day spends a shield
    ///         (if any) and keeps the streak; missing 2+ days, or missing
    ///         a day with no shield, resets it to 1.
    ///         Costs only gas.
    /// @param referrer Optional referrer (address(0) = none). Only read
    ///        on the wallet's FIRST check-in; ignored afterwards. A
    ///        referrer only counts if it already checked in before and is
    ///        not the caller itself — anything else is silently ignored.
    function checkIn(address referrer) external onlyAgentIDHolder {
        uint256 day = currentDay();
        StreakInfo storage s = _streaks[msg.sender];
        if (s.lastCheckInDay == day) revert AlreadyCheckedInToday();

        bool shieldUsed = false;
        if (s.firstCheckInDay == 0) {
            // First ever check-in for this wallet.
            _streakers.push(msg.sender);
            s.firstCheckInDay = uint64(day);
            s.currentStreak = 1;
            _recordReferral(referrer);
        } else {
            uint256 gap = day - s.lastCheckInDay;
            if (gap == 1) {
                // Consecutive day: streak grows.
                s.currentStreak += 1;
            } else if (gap == 2 && _shields[msg.sender] > 0) {
                // Missed exactly one day: spend a shield, keep the streak.
                _shields[msg.sender] -= 1;
                shieldUsed = true;
                emit ShieldUsed(msg.sender, s.currentStreak);
            } else {
                // Missed 2+ days, or missed a day with no shield: reset.
                s.currentStreak = 1;
            }
        }
        if (s.currentStreak > s.longestStreak) {
            s.longestStreak = s.currentStreak;
        }
        s.totalCheckIns += 1;
        s.lastCheckInDay = uint64(day);
        _totalCheckIns += 1;
        emit CheckedIn(msg.sender, day, s.currentStreak);

        // Season 1 tracking stops at SEASON_END; daily check-ins keep
        // working after that, the season state just freezes (view-only).
        if (block.timestamp < SEASON_END) {
            _updateSeason(day, shieldUsed);
        }

        _maybeQualifyReferral();
    }

    /// @dev Update the caller's Season 1 state for today's check-in.
    ///      `shieldUsed` is true when a shield saved the main streak after
    ///      exactly one missed day: the season streak is kept, but the
    ///      "clean" run (no missed day, no shield) restarts at 1 — a
    ///      Survivor week needs 7 real consecutive check-in days.
    function _updateSeason(uint256 day, bool shieldUsed) internal {
        SeasonInfo storage s = _seasons[msg.sender];
        if (s.lastCheckInDay == 0) {
            s.currentStreak = 1;
            s.currentCleanStreak = 1;
        } else if (day == s.lastCheckInDay + 1) {
            s.currentStreak += 1;
            s.currentCleanStreak += 1;
        } else if (day == s.lastCheckInDay + 2 && shieldUsed) {
            // Streak kept by shield; clean run restarts at 1.
            s.currentCleanStreak = 1;
        } else {
            s.currentStreak = 1;
            s.currentCleanStreak = 1;
        }
        s.checkInDays += 1;
        s.lastCheckInDay = uint64(day);
        bool bestChanged = false;
        if (s.currentStreak > s.bestStreak) {
            s.bestStreak = s.currentStreak;
            bestChanged = true;
        }
        if (s.currentCleanStreak > s.bestCleanStreak) {
            s.bestCleanStreak = s.currentCleanStreak;
        }
        if (bestChanged) _updateSeasonTop3(msg.sender);
    }

    /// @dev Keep the live Season 1 top 3 (by best season streak, highest
    ///      first) up to date. Ties keep the earlier entrant ahead: a new
    ///      wallet only displaces an entry with a strictly higher best
    ///      streak. O(1) — no loop over all streakers.
    function _updateSeasonTop3(address user) internal {
        uint256 best = _seasons[user].bestStreak;
        address[3] memory list;
        uint256[3] memory vals;
        uint8 n = 0;
        for (uint8 i = 0; i < 3; i++) {
            address a = _seasonTop3[i];
            if (a != address(0) && a != user) {
                list[n] = a;
                vals[n] = _seasons[a].bestStreak;
                n++;
            }
        }
        uint8 pos = n;
        for (uint8 i = 0; i < n; i++) {
            if (best > vals[i]) {
                pos = i;
                break;
            }
        }
        if (pos < 3) {
            uint8 top = n < 3 ? n : 2;
            for (uint8 j = top; j > pos; j--) {
                list[j] = list[j - 1];
                vals[j] = vals[j - 1];
            }
            list[pos] = user;
            vals[pos] = best;
        }
        for (uint8 i = 0; i < 3; i++) _seasonTop3[i] = list[i];
    }

    /// @dev Record the referrer of a first-time check-in, if valid:
    ///      non-zero, not the caller, and already checked in before.
    function _recordReferral(address referrer) internal {
        if (referrer == address(0)) return;
        if (referrer == msg.sender) return;
        if (_streaks[referrer].firstCheckInDay == 0) return;
        _referredBy[msg.sender] = referrer;
        emit ReferralRecorded(msg.sender, referrer);
    }

    /// @dev After a check-in, if the caller's longest streak just reached
    ///      the qualifying streak and the caller was referred, the referral
    ///      qualifies: the referrer's qualified count grows by 1 and the
    ///      referrer earns one shield unless already at the cap.
    function _maybeQualifyReferral() internal {
        address referrer = _referredBy[msg.sender];
        if (referrer == address(0)) return;
        if (_referralQualified[msg.sender]) return;
        if (_streaks[msg.sender].longestStreak < REFERRAL_QUALIFY_STREAK) {
            return;
        }
        _referralQualified[msg.sender] = true;
        _referralCount[referrer] += 1;
        if (_shields[referrer] < MAX_SHIELDS) {
            _shields[referrer] += 1;
            emit ShieldEarned(referrer, _shields[referrer]);
        }
    }

    /// @notice Claim the soulbound badge for a milestone. Requires the
    ///         wallet's LONGEST streak to reach the milestone (not the
    ///         current streak, so a broken streak does not lose a badge
    ///         already earned). One badge per (wallet, milestone).
    ///         Costs only gas.
    /// @param milestone One of 7 / 14 / 30 / 60 / 100.
    function claimBadge(uint8 milestone) external onlyAgentIDHolder {
        if (!_isMilestone(milestone)) revert InvalidMilestone();
        if (_badgeClaimed[msg.sender][milestone]) {
            revert BadgeAlreadyClaimed();
        }
        if (_streaks[msg.sender].longestStreak < milestone) {
            revert StreakTooShort();
        }
        _badgeClaimed[msg.sender][milestone] = true;
        uint256 tokenId = _mintBadgeToken(msg.sender);
        _badgeTokenId[msg.sender][milestone] = tokenId;
        _badgeMilestone[tokenId] = milestone;
        emit BadgeClaimed(msg.sender, milestone, tokenId);
    }

    /// @notice Claim the Genesis badge — a one-time soulbound badge for
    ///         wallets that check in during the first 7 days after deploy.
    ///         Claimable from the first check-in on, but ONLY while
    ///         `block.timestamp <= GENESIS_DEADLINE`. After the window
    ///         closes the badge can never be claimed by anyone.
    ///         Costs only gas.
    function claimGenesis() external onlyAgentIDHolder {
        if (_specialClaimed[msg.sender][GENESIS_KIND]) {
            revert BadgeAlreadyClaimed();
        }
        if (block.timestamp > GENESIS_DEADLINE) {
            revert GenesisWindowClosed();
        }
        if (_streaks[msg.sender].firstCheckInDay == 0) {
            revert GenesisRequiresCheckIn();
        }
        _specialClaimed[msg.sender][GENESIS_KIND] = true;
        uint256 tokenId = _mintBadgeToken(msg.sender);
        _specialTokenId[msg.sender][GENESIS_KIND] = tokenId;
        _tokenKind[tokenId] = GENESIS_KIND;
        emit GenesisClaimed(msg.sender, tokenId);
    }

    /// @notice Claim the Season 1 Survivor badge — for wallets that checked
    ///         in on all 7 days of any week of Season 1 (a 7-day clean run:
    ///         7 consecutive check-in days with no missed day and no shield
    ///         save). Claimable as soon as the run is complete, during or
    ///         after the season. One per wallet. Costs only gas.
    function claimSurvivor() external onlyAgentIDHolder {
        if (_specialClaimed[msg.sender][SURVIVOR_KIND]) {
            revert BadgeAlreadyClaimed();
        }
        if (_seasons[msg.sender].bestCleanStreak < 7) {
            revert StreakTooShort();
        }
        _specialClaimed[msg.sender][SURVIVOR_KIND] = true;
        uint256 tokenId = _mintBadgeToken(msg.sender);
        _specialTokenId[msg.sender][SURVIVOR_KIND] = tokenId;
        _tokenKind[tokenId] = SURVIVOR_KIND;
        emit SurvivorClaimed(msg.sender, tokenId);
    }

    /// @notice Claim the Season 1 Champion badge — only for the top 3
    ///         Season 1 best streaks, and only AFTER the season ends
    ///         (so the ranking is final). One per wallet. Costs only gas.
    function claimChampion() external onlyAgentIDHolder {
        if (block.timestamp < SEASON_END) revert SeasonNotOver();
        if (_specialClaimed[msg.sender][CHAMPION_KIND]) {
            revert BadgeAlreadyClaimed();
        }
        if (!_isSeasonTop3(msg.sender)) revert NotSeasonTop3();
        _specialClaimed[msg.sender][CHAMPION_KIND] = true;
        uint256 tokenId = _mintBadgeToken(msg.sender);
        _specialTokenId[msg.sender][CHAMPION_KIND] = tokenId;
        _tokenKind[tokenId] = CHAMPION_KIND;
        emit ChampionClaimed(msg.sender, tokenId);
    }

    /// @dev True if `account` is currently in the Season 1 top 3.
    function _isSeasonTop3(address account) internal view returns (bool) {
        return
            _seasonTop3[0] == account ||
            _seasonTop3[1] == account ||
            _seasonTop3[2] == account;
    }

    /// @dev Mint the next badge tokenId to `to`. All badges (milestone and
    ///      special) share one tokenId sequence, so `totalBadges` counts
    ///      every badge ever claimed.
    function _mintBadgeToken(address to) internal returns (uint256) {
        uint256 tokenId = ++_nextTokenId;
        _safeMint(to, tokenId);
        return tokenId;
    }

    /// @dev Soulbound: only minting (from == address(0)) is allowed.
    ///      Every transfer and every burn attempt reverts.
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }

    /// @dev Soulbound: approvals are blocked.
    function approve(address, uint256) public pure override {
        revert Soulbound();
    }

    /// @dev Soulbound: operator approvals are blocked.
    function setApprovalForAll(address, bool) public pure override {
        revert Soulbound();
    }

    /// @notice On-chain SVG metadata for a badge. Fully self-contained:
    ///         data:application/json;base64 wrapping a data:image/svg+xml
    ///         image, no external URL. Special badges (Genesis / Survivor /
    ///         Champion) get their own artwork branch.
    function tokenURI(
        uint256 tokenId
    ) public view override returns (string memory) {
        if (_ownerOf(tokenId) == address(0)) {
            revert NonexistentBadgeToken();
        }
        uint8 kind = _tokenKind[tokenId];
        if (kind != 0) return _specialTokenURI(kind);
        uint8 milestone = _badgeMilestone[tokenId];
        string memory tier = _tierName(milestone);
        string memory color = _tierColor(milestone);
        string memory svg = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">',
            '<rect width="512" height="512" rx="32" fill="#0b0e1a"/>',
            '<rect x="16" y="16" width="480" height="480" rx="24" fill="none" stroke="',
            color,
            '" stroke-width="4"/>',
            '<text x="256" y="110" font-family="sans-serif" font-size="40" font-weight="bold" fill="#ffffff" text-anchor="middle">FLAMEID</text>',
            '<text x="256" y="290" font-family="sans-serif" font-size="130" font-weight="bold" fill="',
            color,
            '" text-anchor="middle">',
            uint256(milestone).toString(),
            "</text>",
            '<text x="256" y="350" font-family="sans-serif" font-size="30" fill="#ffffff" text-anchor="middle">DAY STREAK</text>',
            '<text x="256" y="430" font-family="sans-serif" font-size="34" font-weight="bold" fill="',
            color,
            '" text-anchor="middle">',
            tier,
            "</text>",
            "</svg>"
        );
        string memory json = Base64.encode(
            bytes(
                string.concat(
                    '{"name":"FlameID \u2014 ',
                    uint256(milestone).toString(),
                    "-Day Badge (",
                    tier,
                    ')","description":"Soulbound badge for holding a ',
                    uint256(milestone).toString(),
                    " -day daily check-in streak as a Binance Agent ID holder. Non-transferable. Earned on-chain, no admin, no fees.",
                    '","image":"data:image/svg+xml;base64,',
                    Base64.encode(bytes(svg)),
                    '"}'
                )
            )
        );
        return string.concat("data:application/json;base64,", json);
    }

    /// @dev Metadata for a special badge (Genesis / Survivor / Champion).
    function _specialTokenURI(
        uint8 kind
    ) internal pure returns (string memory) {
        string memory bigText;
        string memory tier;
        string memory color;
        string memory sub;
        string memory desc;
        if (kind == GENESIS_KIND) {
            bigText = "GENESIS";
            tier = "Genesis";
            color = "#FF6B35";
            sub = "FIRST WEEK";
            desc = "Soulbound Genesis badge: checked in during the first 7 days after the FlameID contract deployed. The Genesis window closed forever after one week. Non-transferable.";
        } else if (kind == SURVIVOR_KIND) {
            bigText = "7/7";
            tier = "Survivor";
            color = "#7EE2A8";
            sub = "WEEK SURVIVOR";
            desc = "Soulbound Season 1 Survivor badge: checked in on all 7 days of a week of Season 1. Non-transferable.";
        } else {
            bigText = "TOP 3";
            tier = "Champion";
            color = "#FFD700";
            sub = "SEASON 1 CHAMPION";
            desc = "Soulbound Season 1 Champion badge: one of the three longest Season 1 streaks. Non-transferable.";
        }
        string memory svg = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">',
            '<rect width="512" height="512" rx="32" fill="#0b0e1a"/>',
            '<rect x="16" y="16" width="480" height="480" rx="24" fill="none" stroke="',
            color,
            '" stroke-width="4"/>',
            '<text x="256" y="110" font-family="sans-serif" font-size="40" font-weight="bold" fill="#ffffff" text-anchor="middle">FLAMEID</text>',
            '<text x="256" y="290" font-family="sans-serif" font-size="64" font-weight="bold" fill="',
            color,
            '" text-anchor="middle">',
            bigText,
            "</text>",
            '<text x="256" y="350" font-family="sans-serif" font-size="30" fill="#ffffff" text-anchor="middle">',
            sub,
            "</text>",
            '<text x="256" y="430" font-family="sans-serif" font-size="34" font-weight="bold" fill="',
            color,
            '" text-anchor="middle">',
            tier,
            "</text>",
            "</svg>"
        );
        string memory json = Base64.encode(
            bytes(
                string.concat(
                    '{"name":"FlameID \u2014 ',
                    tier,
                    ' Badge","description":"',
                    desc,
                    '","image":"data:image/svg+xml;base64,',
                    Base64.encode(bytes(svg)),
                    '"}'
                )
            )
        );
        return string.concat("data:application/json;base64,", json);
    }

    /// @notice Full streak state of `account`.
    function streakOf(
        address account
    )
        external
        view
        returns (
            uint256 currentStreak,
            uint256 longestStreak,
            uint256 checkIns,
            uint256 lastCheckInDay,
            uint256 firstCheckInDay
        )
    {
        StreakInfo storage s = _streaks[account];
        return (
            s.currentStreak,
            s.longestStreak,
            s.totalCheckIns,
            s.lastCheckInDay,
            s.firstCheckInDay
        );
    }

    /// @notice True if `account` holds an Agent ID and has not checked in
    ///         yet today (UTC day).
    function canCheckInToday(address account) external view returns (bool) {
        return
            AGENT_ID_REGISTRY.balanceOf(account) > 0 &&
            _streaks[account].lastCheckInDay != currentDay();
    }

    /// @notice Number of wallets that ever checked in.
    function totalStreakers() external view returns (uint256) {
        return _streakers.length;
    }

    /// @notice Streaker at `index` (insertion order).
    function streakerAt(uint256 index) external view returns (address) {
        return _streakers[index];
    }

    /// @notice Total check-ins across all wallets.
    function totalCheckIns() external view returns (uint256) {
        return _totalCheckIns;
    }

    /// @notice Total badges claimed across all wallets.
    function totalBadges() external view returns (uint256) {
        return _nextTokenId;
    }

    /// @notice True if `account` already claimed the badge for `milestone`.
    function hasBadge(
        address account,
        uint8 milestone
    ) external view returns (bool) {
        return _badgeClaimed[account][milestone];
    }

    /// @notice Badge tokenId of `account` for `milestone` (0 = none).
    function badgeTokenOf(
        address account,
        uint8 milestone
    ) external view returns (uint256) {
        return _badgeTokenId[account][milestone];
    }

    /// @notice Milestone a badge tokenId was claimed for (0 = none).
    function badgeMilestoneOf(uint256 tokenId) external view returns (uint8) {
        return _badgeMilestone[tokenId];
    }

    /// @notice Number of QUALIFIED referrals of `account` (invitees that
    ///         reached a 3-day streak).
    function referralCount(address account) external view returns (uint256) {
        return _referralCount[account];
    }

    /// @notice Streak shields currently held by `account`.
    function shields(address account) external view returns (uint256) {
        return _shields[account];
    }

    /// @notice Who referred `account` (address(0) = no referrer).
    function referredBy(address account) external view returns (address) {
        return _referredBy[account];
    }

    /// @notice Reputation score of `account` (max 140), pure view built
    ///         only from state the contract already tracks:
    ///         current streak (max 50) + total check-ins (max 30) +
    ///         qualified referrals (max 30) + account age in days since the
    ///         first check-in (max 20) + shields held (max 10).
    ///         Other dApps can use this as an Agent ID reputation signal.
    function scoreOf(address account) public view returns (uint256) {
        StreakInfo storage s = _streaks[account];
        uint256 score = 0;
        score += s.currentStreak > 50 ? 50 : s.currentStreak;
        score += s.totalCheckIns > 30 ? 30 : s.totalCheckIns;
        uint256 refs = _referralCount[account];
        score += refs > 30 ? 30 : refs;
        if (s.firstCheckInDay != 0) {
            uint256 age = currentDay() - s.firstCheckInDay;
            score += age > 20 ? 20 : age;
        }
        uint256 sh = _shields[account];
        score += sh > 10 ? 10 : sh;
        return score;
    }

    /// @notice True when `account` is an active Agent ID holder for gating:
    ///         registered (checked in at least once), checked in today or
    ///         yesterday (within the last 2 UTC days), and scoring at least
    ///         `minScore`. Pure view — any other dApp can call it for free.
    function isActiveAgent(
        address account,
        uint256 minScore
    ) external view returns (bool) {
        StreakInfo storage s = _streaks[account];
        if (s.firstCheckInDay == 0) return false;
        if (currentDay() - s.lastCheckInDay > 1) return false;
        return scoreOf(account) >= minScore;
    }

    /// @notice True while Season 1 is still running.
    function seasonActive() external view returns (bool) {
        return block.timestamp < SEASON_END;
    }

    /// @notice Full Season 1 state of `account`: check-in days in the
    ///         season, current season streak, best season streak, current
    ///         clean (no shield) run, best clean run, last season
    ///         check-in day.
    function seasonOf(
        address account
    )
        external
        view
        returns (
            uint256 checkInDays,
            uint256 currentStreak,
            uint256 bestStreak,
            uint256 currentCleanStreak,
            uint256 bestCleanStreak,
            uint256 lastCheckInDay
        )
    {
        SeasonInfo storage s = _seasons[account];
        return (
            s.checkInDays,
            s.currentStreak,
            s.bestStreak,
            s.currentCleanStreak,
            s.bestCleanStreak,
            s.lastCheckInDay
        );
    }

    /// @notice Live Season 1 top 3 by best season streak (highest first),
    ///         with each wallet's best season streak. Empty slots are the
    ///         zero address with streak 0.
    function seasonTop3()
        external
        view
        returns (address[3] memory addrs, uint256[3] memory bestStreaks)
    {
        for (uint8 i = 0; i < 3; i++) {
            addrs[i] = _seasonTop3[i];
            bestStreaks[i] = _seasonTop3[i] == address(0)
                ? 0
                : _seasons[_seasonTop3[i]].bestStreak;
        }
    }

    /// @notice True if `account` already claimed the special badge `kind`
    ///         (1 Genesis, 2 Survivor, 3 Champion).
    function hasSpecialBadge(
        address account,
        uint8 kind
    ) external view returns (bool) {
        return _specialClaimed[account][kind];
    }

    /// @notice Special badge tokenId of `account` for `kind` (0 = none).
    function specialBadgeTokenOf(
        address account,
        uint8 kind
    ) external view returns (uint256) {
        return _specialTokenId[account][kind];
    }

    /// @notice Special kind of a badge tokenId (0 = milestone badge).
    function badgeKindOf(uint256 tokenId) external view returns (uint8) {
        return _tokenKind[tokenId];
    }

    function _isMilestone(uint8 milestone) internal pure returns (bool) {
        return
            milestone == 7 ||
            milestone == 14 ||
            milestone == 30 ||
            milestone == 60 ||
            milestone == 100;
    }

    function _tierName(uint8 milestone) internal pure returns (string memory) {
        if (milestone == 7) return "Bronze";
        if (milestone == 14) return "Silver";
        if (milestone == 30) return "Gold";
        if (milestone == 60) return "Platinum";
        return "Diamond";
    }

    function _tierColor(
        uint8 milestone
    ) internal pure returns (string memory) {
        if (milestone == 7) return "#CD7F32";
        if (milestone == 14) return "#C0C0C0";
        if (milestone == 30) return "#FFD700";
        if (milestone == 60) return "#E5E4E2";
        return "#B9F2FF";
    }
}
