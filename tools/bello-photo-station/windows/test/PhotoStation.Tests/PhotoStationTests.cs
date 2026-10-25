using System.Globalization;
using System.Reflection;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using PhotoStation.Application;
using PhotoStation.Desktop;
using PhotoStation.Domain;
using PhotoStation.Infrastructure;

namespace PhotoStation.Tests;

public sealed class PhotoStationTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "bello-photo-tests", Guid.NewGuid().ToString("N"));
    public void Dispose() { if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true); }

    [Fact]
    public void StateMachineRejectsSkippingLocalVerification()
    {
        var session = Session();
        Assert.Throws<InvalidOperationException>(() => session.TransitionTo(ImportSessionState.ReadyToUpload));
        session.TransitionTo(ImportSessionState.Snapshotting);
        session.TransitionTo(ImportSessionState.Copying);
        session.TransitionTo(ImportSessionState.LocalSecured);
        Assert.Equal(ImportSessionState.LocalSecured, session.State);
    }

    [Fact]
    public void NeedsReviewRequiresReason()
    {
        var session = Session(); session.TransitionTo(ImportSessionState.Snapshotting);
        Assert.Throws<ArgumentException>(() => session.TransitionTo(ImportSessionState.NeedsReview));
    }

    [Theory]
    [InlineData("../escape.jpg")]
    [InlineData("C:/escape.jpg")]
    public void CopierRejectsPathsOutsideRoot(string path) => Assert.ThrowsAny<Exception>(() => VerifiedFileCopier.ResolveUnderRoot(_root, path));

    [Fact]
    public async Task CopyUsesPartialThenVerifiesSha256()
    {
        var source = Path.Combine(_root, "card"); Directory.CreateDirectory(source);
        await File.WriteAllTextAsync(Path.Combine(source, "x.jpg"), "verified bytes");
        var result = await new VerifiedFileCopier().CopyAndVerifyAsync(source, "x.jpg", Path.Combine(_root, "session"));
        Assert.True(File.Exists(result.LocalPath)); Assert.False(File.Exists(result.LocalPath + ".partial")); Assert.Equal(64, result.Sha256.Length);
    }

    [Fact]
    public async Task ImportIsDurableAndIdempotentForSameSessionAndManifest()
    {
        var source = Path.Combine(_root, "card"); Directory.CreateDirectory(source);
        await File.WriteAllTextAsync(Path.Combine(source, "x.jpg"), "one");
        var repository = new SqliteStationRepository(Path.Combine(_root, "db", "station.sqlite")); await repository.InitializeAsync();
        var service = new ImportService(repository, new VerifiedFileCopier()); var id = Guid.NewGuid();
        var candidate = new SourceCandidate("x.jpg", 3, File.GetLastWriteTimeUtc(Path.Combine(source, "x.jpg")));
        var request = new ImportRequest(id, "staging", "STATION-1", "GEN-1", source, Path.Combine(_root, "sessions", id.ToString()), [candidate]);
        var first = await service.ImportAsync(request); var second = await service.ImportAsync(request);
        Assert.True(first.SafeToRemove); Assert.Equal(ImportSessionState.LocalSecured, second.State); Assert.Single(await repository.ListSessionsAsync());
    }

    [Fact]
    public async Task TwentyFilesBecomeOneLocallySecuredSession()
    {
        var source = Path.Combine(_root, "card"); Directory.CreateDirectory(source); var candidates = new List<SourceCandidate>();
        for (var i = 0; i < 20; i++) { var name = $"DSC{i:0000}.JPG"; var file = Path.Combine(source, name); await File.WriteAllTextAsync(file, "image-" + i); var info = new FileInfo(file); candidates.Add(new SourceCandidate(name, info.Length, info.LastWriteTimeUtc)); }
        var repository = new SqliteStationRepository(Path.Combine(_root, "db", "station.sqlite")); await repository.InitializeAsync(); var id = Guid.NewGuid();
        var result = await new ImportService(repository, new VerifiedFileCopier()).ImportAsync(new ImportRequest(id, "staging", "STATION-1", "GEN-1", source, Path.Combine(_root, "sessions", id.ToString()), candidates));
        Assert.Equal(20, result.VerifiedCount); Assert.True(result.SafeToRemove);
    }

    [Fact]
    public async Task TwoProductsOnOneCardRemainSeparateSessions()
    {
        var source = Path.Combine(_root, "card", "DCIM"); Directory.CreateDirectory(source);
        var candidates = new List<SourceCandidate>();
        foreach (var name in new[] { "chair-1.jpg", "chair-2.jpg", "lamp-1.jpg", "lamp-2.jpg" }) {
            var file = Path.Combine(source, name); await File.WriteAllTextAsync(file, name);
            var info = new FileInfo(file);
            candidates.Add(new SourceCandidate(name, info.Length, info.LastWriteTimeUtc));
        }
        var repository = new SqliteStationRepository(Path.Combine(_root, "db", "station.sqlite"));
        await repository.InitializeAsync();
        var service = new ImportService(repository, new VerifiedFileCopier());
        var chairId = Guid.NewGuid(); var lampId = Guid.NewGuid();
        var chair = await service.ImportAsync(new ImportRequest(chairId, "staging", "TEST", "SAME-CARD", source,
            Path.Combine(_root, "sessions", chairId.ToString()), candidates.Take(2).ToArray()));
        Assert.Equal(2, chair.VerifiedCount);
        foreach (var item in candidates.Take(2)) Assert.True(await repository.IsSourceKnownAsync("SAME-CARD", item));
        foreach (var item in candidates.Skip(2)) Assert.False(await repository.IsSourceKnownAsync("SAME-CARD", item));
        var known = await repository.LoadKnownSourcesAsync("SAME-CARD");
        Assert.Equal(2, known.Count);
        foreach (var item in candidates.Take(2)) Assert.Contains(item, known);
        foreach (var item in candidates.Skip(2)) Assert.DoesNotContain(item, known);
        Assert.Empty(await repository.LoadKnownSourcesAsync("OTHER-CARD"));
        var lamp = await service.ImportAsync(new ImportRequest(lampId, "staging", "TEST", "SAME-CARD", source,
            Path.Combine(_root, "sessions", lampId.ToString()), candidates.Skip(2).ToArray()));
        Assert.Equal(2, lamp.VerifiedCount);
        Assert.Equal(2, (await repository.ListSessionsAsync()).Count);
        Assert.Equal(2, Directory.GetFiles(Path.Combine(_root, "sessions", chairId.ToString(), "source")).Length);
        Assert.Equal(2, Directory.GetFiles(Path.Combine(_root, "sessions", lampId.ToString(), "source")).Length);
    }

    [Fact]
    public async Task InsertedCardCanBeReadAndCopiedWithoutChangingSource()
    {
        var source = Environment.GetEnvironmentVariable("BELLO_TEST_CARD_ROOT");
        if (string.IsNullOrWhiteSpace(source)) return;
        var dcim = Path.Combine(source, "DCIM");
        Assert.True(Directory.Exists(dcim), "BELLO_TEST_CARD_ROOT must contain DCIM");
        var files = Directory.EnumerateFiles(dcim, "*", SearchOption.AllDirectories)
            .Where(path => new[] { ".arw", ".jpg", ".jpeg" }.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase))
            .Select(path => new FileInfo(path)).ToArray();
        Assert.NotEmpty(files);
        var before = files.ToDictionary(file => file.FullName, file => (file.Length, file.LastWriteTimeUtc));
        var candidates = files.Select(file => new SourceCandidate(Path.GetRelativePath(source, file.FullName), file.Length, file.LastWriteTimeUtc)).ToArray();
        var repository = new SqliteStationRepository(Path.Combine(_root, "db", "real-card.sqlite"));
        await repository.InitializeAsync();
        var result = await new ImportService(repository, new VerifiedFileCopier()).ImportAsync(new ImportRequest(
            Guid.NewGuid(), "staging", "PORTABILITY-TEST", "READ-ONLY-CARD-TEST", source,
            Path.Combine(_root, "real-card-session"), candidates));
        Assert.Equal(files.Length, result.VerifiedCount);
        Assert.True(result.SafeToRemove);
        foreach (var file in files)
        {
            file.Refresh();
            Assert.Equal(before[file.FullName], (file.Length, file.LastWriteTimeUtc));
        }
    }

    [Fact]
    public async Task LightroomBridgePublishesOnlyCompleteValidatedRequests()
    {
        var station = Path.Combine(_root, "station");
        var source = Path.Combine(station, "sessions", "one", "source", "one.arw");
        var output = Path.Combine(station, "sessions", "one", "render", "asset", "attempt");
        Directory.CreateDirectory(Path.GetDirectoryName(source)!);
        await File.WriteAllTextAsync(source, "raw");
        var request = new LightroomRenderRequest(1, Guid.NewGuid(), Guid.NewGuid(), 1, Guid.NewGuid(),
            "bello-raw-neutral-v1", new string('a', 64),
            [new LightroomRenderItem(Guid.NewGuid(), source, new string('b', 64), output)]);
        var path = await new LightroomBridgeWriter(Path.Combine(station, "bridge"), station).EnqueueAsync(request);
        Assert.EndsWith(".ready.json", path);
        Assert.True(File.Exists(path));
        Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(path)!, "*.partial"));
    }

    [Fact]
    public void LightroomBridgeRejectsPathsOutsideStationRoot()
    {
        var station = Path.Combine(_root, "station");
        var request = new LightroomRenderRequest(1, Guid.NewGuid(), Guid.NewGuid(), 1, Guid.NewGuid(),
            "bello-raw-neutral-v1", new string('a', 64),
            [new LightroomRenderItem(Guid.NewGuid(), Path.Combine(_root, "outside.arw"), new string('b', 64), Path.Combine(station, "out"))]);
        Assert.Throws<InvalidDataException>(() => LightroomBridgeProtocol.Validate(request, station));
    }

    private static ImportSession Session() => new(Guid.NewGuid(), "staging", "STATION-1", "GEN-1", "manifest", DateTimeOffset.UtcNow);

    [Fact]
    public void ThumbnailConverterDownsizesInsteadOfDecodingFullImage()
    {
        RunSta(() =>
        {
            Directory.CreateDirectory(_root);
            var path = Path.Combine(_root, "large.jpg");
            SaveTestJpeg(path, 800, 600);
            var converterType = typeof(ProductImageSelectionWindow).GetNestedType("ThumbnailConverter", BindingFlags.NonPublic)!;
            var converter = (IValueConverter)Activator.CreateInstance(converterType)!;
            var thumbnail = (BitmapImage)converter.Convert(path, typeof(ImageSource), null!, CultureInfo.InvariantCulture)!;
            Assert.True(thumbnail.PixelWidth < 800, "candidate list must decode a reduced thumbnail, not the full-size image");
            Assert.Equal(360, thumbnail.PixelWidth);
        });
    }

    [Fact]
    public void CandidateGridShowsThreeColumnsAndTogglesSelection()
    {
        RunSta(() =>
        {
            Directory.CreateDirectory(_root);
            var files = new List<FileInfo>();
            for (var i = 0; i < 3; i++)
            {
                var path = Path.Combine(_root, $"photo{i}.jpg");
                SaveTestJpeg(path, 400, 300);
                files.Add(new FileInfo(path));
            }
            var window = new ProductImageSelectionWindow(files);
            var photos = (ListBox)typeof(ProductImageSelectionWindow)
                .GetField("_photos", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(window)!;
            var count = (TextBlock)typeof(ProductImageSelectionWindow)
                .GetField("_count", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(window)!;

            photos.ItemsPanel.Seal();
            var wrapPanel = (WrapPanel)photos.ItemsPanel.LoadContent();
            var columns = Math.Floor((window.Width - 32) / wrapPanel.ItemWidth);
            Assert.True(columns is >= 2 and <= 3,
                "candidates must lay out as a two-to-three column grid of large thumbnails");

            var importButton = FindButton(window, "選択した1商品を取り込む");
            Assert.False(importButton.IsEnabled);
            Assert.Equal("", count.Text);

            photos.SelectedItems.Add(files[0]);
            Assert.True(importButton.IsEnabled);
            Assert.Equal("1枚を選択", count.Text);

            photos.SelectedItems.Add(files[1]);
            Assert.Equal("2枚を選択", count.Text);

            photos.SelectedItems.Remove(files[0]);
            Assert.Equal("1枚を選択", count.Text);

            photos.SelectedItems.Remove(files[1]);
            Assert.False(importButton.IsEnabled);
            Assert.Equal("0枚を選択", count.Text);

            var style = (Style)typeof(ProductImageSelectionWindow)
                .GetMethod("BuildSelectionStyle", BindingFlags.NonPublic | BindingFlags.Static)!.Invoke(null, null)!;
            var trigger = Assert.IsType<Trigger>(Assert.Single(style.Triggers));
            Assert.Equal(ListBoxItem.IsSelectedProperty, trigger.Property);
        });
    }

    private static Button FindButton(DependencyObject root, string content) =>
        FindButtonOrNull(root, content) ?? throw new InvalidOperationException($"Button '{content}' not found");

    private static Button? FindButtonOrNull(DependencyObject root, string content)
    {
        foreach (var child in LogicalTreeHelper.GetChildren(root))
        {
            if (child is not DependencyObject node) continue;
            if (node is Button button && Equals(button.Content, content)) return button;
            var found = FindButtonOrNull(node, content);
            if (found is not null) return found;
        }
        return null;
    }

    private static void SaveTestJpeg(string path, int width, int height)
    {
        var visual = new DrawingVisual();
        using (var context = visual.RenderOpen())
            context.DrawRectangle(Brushes.White, null, new Rect(0, 0, width, height));
        var bitmap = new RenderTargetBitmap(width, height, 96, 96, PixelFormats.Pbgra32);
        bitmap.Render(visual);
        var encoder = new JpegBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(bitmap));
        using var stream = File.Create(path);
        encoder.Save(stream);
    }

    private static void RunSta(Action action)
    {
        System.Runtime.ExceptionServices.ExceptionDispatchInfo? failure = null;
        var thread = new Thread(() =>
        {
            try { action(); }
            catch (Exception error) { failure = System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error); }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        failure?.Throw();
    }
}
